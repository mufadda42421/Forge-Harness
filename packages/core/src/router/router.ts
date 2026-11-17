import { and, eq } from "drizzle-orm";
import { schema, type ForgeDatabase } from "@forge/database";
import { ForgeError, estimateCostUsd } from "@forge/shared";
import type {
  ChatCompletionParams,
  ChatCompletionResult,
  ChatMessage,
  ChatStreamEvent,
  TokenUsage,
} from "@forge/shared";
import { CredentialCipher, redactSecrets } from "@forge/security";
import { createAdapter } from "../providers/factory.js";
import type { ProviderAdapter, ProviderConfig } from "../providers/types.js";

export interface RouterContext {
  agentExecutionId?: string;
  workflowExecutionId?: string;
  agentId?: string;
}

export interface RouterRequest extends RouterContext {
  modelRowId: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  tools?: ChatCompletionParams["tools"];
  responseFormat?: "text" | "json";
  signal?: AbortSignal;
  /** Override temperature/maxTokens with the model row defaults, off by default */
  useModelDefaults?: boolean;
}

export interface RouterResult extends ChatCompletionResult {
  estimatedCostUsd: number | null;
  costIsEstimated: true;
  modelRowId: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Provider-independent routing engine.
 *
 * Guarantees:
 *  - Never silently switches provider or model. A `modelRowId` always resolves
 *    to exactly one configured provider; fallbacks must be explicit workflow/agent config.
 *  - Records every request outcome (success and error) to model_requests.
 *  - Costs are estimated from user-configured pricing; null when unknown.
 */
export class ModelRouter {
  constructor(
    private readonly db: ForgeDatabase,
    private readonly cipher: CredentialCipher | null,
  ) {}

  async resolveModel(modelRowId: string) {
    const rows = await this.db
      .select({
        model: schema.models,
        provider: schema.providers,
      })
      .from(schema.models)
      .innerJoin(schema.providers, eq(schema.models.providerId, schema.providers.id))
      .where(eq(schema.models.id, modelRowId))
      .limit(1);
    const row = rows[0];
    if (!row) throw ForgeError.notFound("Model");
    const { model, provider } = row;
    if (!provider.enabled) {
      throw new ForgeError("PROVIDER_ERROR", `Provider "${provider.name}" is disabled`, 409);
    }
    if (!model.enabled) {
      throw new ForgeError("MODEL_NOT_AVAILABLE", `Model "${model.displayName}" is disabled`, 409);
    }

    const apiKey = this.loadApiKey(provider.id, provider.authMethod);
    if (provider.authMethod !== "none" && !apiKey) {
      throw new ForgeError(
        "CREDENTIAL_ERROR",
        `Provider "${provider.name}" has no API key configured. Add one under Model Hub → Providers.`,
        422,
      );
    }

    let customHeaders: Record<string, string> = {};
    try {
      const parsed = JSON.parse(provider.customHeadersJson) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        customHeaders = parsed as Record<string, string>;
      }
    } catch {
      customHeaders = {};
    }

    const config: ProviderConfig = {
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      compatibility: provider.compatibility as ProviderConfig["compatibility"],
      authMethod: provider.authMethod as ProviderConfig["authMethod"],
      apiKey,
      customHeaders,
      timeoutMs: provider.timeoutMs,
      maxRetries: provider.maxRetries,
    };
    return { model, provider, config, adapter: createAdapter(config) };
  }

  private loadApiKey(providerId: string, authMethod: string): string | null {
    if (authMethod === "none") return null;
    if (!this.cipher) {
      throw new ForgeError(
        "CREDENTIAL_ERROR",
        "Credential encryption is not available on this server (master key could not be initialized).",
        500,
      );
    }
    const secrets = this.db
      .select()
      .from(schema.credentialSecrets)
      .where(and(eq(schema.credentialSecrets.refType, "provider"), eq(schema.credentialSecrets.refId, providerId)))
      .all();
    const secret = secrets[0];
    if (!secret) return null;
    try {
      return this.cipher.decrypt({
        ciphertext: secret.ciphertext,
        iv: secret.iv,
        authTag: secret.authTag,
        algorithm: "aes-256-gcm",
      });
    } catch {
      throw new ForgeError("CREDENTIAL_ERROR", "Stored credential could not be decrypted (master key changed?). Re-enter the API key.", 500);
    }
  }

  private static isRetryable(err: unknown): boolean {
    if (!(err instanceof ForgeError)) return false;
    return err.code === "PROVIDER_RATE_LIMIT" || err.code === "PROVIDER_UNREACHABLE" || err.code === "PROVIDER_TIMEOUT";
  }

  private priceOf(model: { inputCostPer1M: number | null; outputCostPer1M: number | null; costConfigured: boolean }) {
    return { inputCostPer1M: model.inputCostPer1M, outputCostPer1M: model.outputCostPer1M };
  }

  async chat(request: RouterRequest): Promise<RouterResult> {
    const { model, provider, adapter } = await this.resolveModel(request.modelRowId);

    const params: ChatCompletionParams = {
      model: model.modelId,
      messages: request.messages,
      temperature: request.temperature,
      maxTokens: request.maxTokens,
      tools: request.tools,
      responseFormat: request.responseFormat,
      signal: request.signal,
    };

    let attempt = 0;
    for (;;) {
      try {
        const result = await adapter.chatCompletion(params);
        const estimatedCostUsd = estimateCostUsd(result.usage, this.priceOf(model));
        this.recordSuccess(request, provider.id, model, result, estimatedCostUsd);
        return { ...result, estimatedCostUsd, costIsEstimated: true, modelRowId: model.id };
      } catch (err) {
        if (attempt >= provider.maxRetries || !ModelRouter.isRetryable(err) || request.signal?.aborted) {
          this.recordError(request, provider.id, model, err);
          throw err;
        }
        const backoff = Math.min(1000 * 2 ** attempt, 15_000) + Math.floor(Math.random() * 250);
        attempt += 1;
        await sleep(backoff);
      }
    }
  }

  /**
   * Streaming variant. Retries are only safe before the first byte is
   * received; once deltas flow, errors are surfaced as stream events.
   */
  async *chatStream(request: RouterRequest): AsyncGenerator<ChatStreamEvent & { estimatedCostUsd?: number | null }> {
    const resolved = await this.resolveModel(request.modelRowId);
    const { model, provider, adapter } = resolved;
    const started = Date.now();

    const params: ChatCompletionParams = {
      model: model.modelId,
      messages: request.messages,
      temperature: request.temperature,
      maxTokens: request.maxTokens,
      tools: request.tools,
      responseFormat: request.responseFormat,
      signal: request.signal,
    };

    let usage: TokenUsage = { promptTokens: null, completionTokens: null, totalTokens: null };
    let content = "";
    let finishReason: string | null = null;
    try {
      for await (const event of adapter.chatCompletionStream(params)) {
        if (event.type === "usage") usage = event.usage;
        if (event.type === "delta") content += event.text;
        if (event.type === "done") finishReason = event.finishReason;
        if (event.type === "done") {
          const estimatedCostUsd = estimateCostUsd(usage, this.priceOf(model));
          const result: ChatCompletionResult = {
            content,
            toolCalls: [],
            usage,
            finishReason,
            model: model.modelId,
            providerId: provider.id,
            latencyMs: Date.now() - started,
          };
          this.recordSuccess(request, provider.id, model, result, estimatedCostUsd);
          yield { ...event, estimatedCostUsd };
        } else {
          yield event;
        }
      }
    } catch (err) {
      this.recordError(request, provider.id, model, err);
      throw err;
    }
  }

  private recordSuccess(
    request: RouterRequest,
    providerId: string,
    model: { id: string; modelId: string },
    result: ChatCompletionResult,
    estimatedCostUsd: number | null,
  ) {
    try {
      this.db.transaction((tx) => {
        const inserted = tx
          .insert(schema.modelRequests)
          .values({
            providerId,
            modelRowId: model.id,
            modelId: result.model || model.modelId,
            agentExecutionId: request.agentExecutionId ?? null,
            workflowExecutionId: request.workflowExecutionId ?? null,
            status: "success",
            promptTokens: result.usage.promptTokens,
            completionTokens: result.usage.completionTokens,
            totalTokens: result.usage.totalTokens,
            estimatedCostUsd,
            costIsEstimated: true,
            latencyMs: result.latencyMs,
          })
          .returning({ id: schema.modelRequests.id })
          .all()[0];
        tx.insert(schema.usageRecords).values({
          providerId,
          modelRowId: model.id,
          agentId: request.agentId ?? null,
          workflowExecutionId: request.workflowExecutionId ?? null,
          modelRequestId: inserted?.id ?? null,
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          totalTokens: result.usage.totalTokens,
          estimatedCostUsd,
          latencyMs: result.latencyMs,
        }).run();
      });
    } catch (err) {
      // Recording must never break a successful inference call.
      console.error("[forge] failed to record usage:", err);
    }
  }

  private recordError(
    request: RouterRequest,
    providerId: string,
    model: { id: string; modelId: string },
    err: unknown,
  ) {
    try {
      const forge = err instanceof ForgeError ? err : null;
      const code = forge?.code ?? "PROVIDER_ERROR";
      const message = redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 500);
      this.db.insert(schema.modelRequests).values({
        providerId,
        modelRowId: model.id,
        modelId: model.modelId,
        agentExecutionId: request.agentExecutionId ?? null,
        workflowExecutionId: request.workflowExecutionId ?? null,
        status: "error",
        estimatedCostUsd: null,
        costIsEstimated: true,
        latencyMs: null,
        errorCode: code,
        errorMessage: message,
      }).run();
    } catch (recErr) {
      console.error("[forge] failed to record error:", recErr);
    }
  }
}
