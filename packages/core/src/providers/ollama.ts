import { ForgeError } from "@forge/shared";
import type {
  ChatCompletionParams,
  ChatCompletionResult,
  ChatStreamEvent,
  TokenUsage,
} from "@forge/shared";
import { assertOk, readErrorBody } from "./sse.js";
import {
  buildAuthHeaders,
  fetchWithTimeout,
  joinUrl,
  type ConnectionTestResult,
  type DiscoveredModel,
  type ProviderAdapter,
  type ProviderConfig,
} from "./types.js";

/**
 * Adapter for Ollama's native HTTP API (default http://127.0.0.1:11434).
 * Ollama normally requires no API key; discovery via GET /api/tags.
 */
export class OllamaAdapter implements ProviderAdapter {
  readonly compatibility = "ollama" as const;

  constructor(private readonly config: ProviderConfig) {}

  private headers(): Record<string, string> {
    return buildAuthHeaders(this.config);
  }

  async testConnection(signal?: AbortSignal): Promise<ConnectionTestResult> {
    const started = Date.now();
    const models = await this.discoverModels(signal);
    return {
      ok: true,
      latencyMs: Date.now() - started,
      detail: `Reached Ollama at ${this.config.baseUrl}; /api/tags returned ${models.length} local model(s)`,
      discoveredModels: models.length,
    };
  }

  async discoverModels(signal?: AbortSignal): Promise<DiscoveredModel[]> {
    const res = await fetchWithTimeout(
      joinUrl(this.config.baseUrl, "/api/tags"),
      { method: "GET", headers: this.headers() },
      this.config.timeoutMs,
      signal,
    );
    if (!res.ok) {
      const preview = await readErrorBody(res);
      assertOk(res, preview);
    }
    const json = (await res.json()) as { models?: Array<{ name?: string; details?: { parameter_size?: string } }> };
    return (json.models ?? []).flatMap((m) => (typeof m.name === "string" && m.name ? [{ modelId: m.name }] : []));
  }

  private requestBody(params: ChatCompletionParams, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: params.model,
      stream,
      messages: params.messages.map((m) => ({ role: m.role, content: m.content })),
      options: {
        ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
        ...(params.maxTokens !== undefined ? { num_predict: params.maxTokens } : {}),
      },
    };
    if (params.responseFormat === "json") body["format"] = "json";
    return body;
  }

  private static parseUsage(json: {
    prompt_eval_count?: number;
    eval_count?: number;
  }): TokenUsage {
    const p = json.prompt_eval_count ?? null;
    const c = json.eval_count ?? null;
    return { promptTokens: p, completionTokens: c, totalTokens: p !== null && c !== null ? p + c : null };
  }

  async chatCompletion(params: ChatCompletionParams): Promise<ChatCompletionResult> {
    const started = Date.now();
    const res = await fetchWithTimeout(
      joinUrl(this.config.baseUrl, "/api/chat"),
      { method: "POST", headers: this.headers(), body: JSON.stringify(this.requestBody(params, false)) },
      this.config.timeoutMs,
      params.signal,
    );
    if (!res.ok) {
      const preview = await readErrorBody(res);
      assertOk(res, preview);
    }
    const json = (await res.json()) as {
      message?: { content?: string };
      done_reason?: string;
      prompt_eval_count?: number;
      eval_count?: number;
    };
    return {
      content: json.message?.content ?? "",
      toolCalls: [],
      usage: OllamaAdapter.parseUsage(json),
      finishReason: json.done_reason ?? null,
      model: params.model,
      providerId: this.config.id,
      latencyMs: Date.now() - started,
      raw: json,
    };
  }

  async *chatCompletionStream(params: ChatCompletionParams): AsyncGenerator<ChatStreamEvent> {
    const res = await fetchWithTimeout(
      joinUrl(this.config.baseUrl, "/api/chat"),
      { method: "POST", headers: this.headers(), body: JSON.stringify(this.requestBody(params, true)) },
      this.config.timeoutMs,
      params.signal,
    );
    if (!res.ok) {
      const preview = await readErrorBody(res);
      assertOk(res, preview);
    }
    if (!res.body) {
      throw ForgeError.provider("Ollama returned an empty stream body", 502);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finishReason: string | null = null;
    let usage: TokenUsage = { promptTokens: null, completionTokens: null, totalTokens: null };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let json: {
            message?: { content?: string };
            done?: boolean;
            done_reason?: string;
            prompt_eval_count?: number;
            eval_count?: number;
          };
          try {
            json = JSON.parse(trimmed);
          } catch {
            continue;
          }
          if (json.message?.content) yield { type: "delta", text: json.message.content };
          if (json.prompt_eval_count !== undefined || json.eval_count !== undefined) {
            usage = OllamaAdapter.parseUsage(json);
          }
          if (json.done) finishReason = json.done_reason ?? "stop";
        }
      }
    } finally {
      reader.releaseLock();
    }
    if (usage.totalTokens !== null || usage.promptTokens !== null) {
      yield { type: "usage", usage };
    }
    yield { type: "done", finishReason };
  }
}
