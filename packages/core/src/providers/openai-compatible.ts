import { ForgeError } from "@forge/shared";
import type {
  ChatCompletionParams,
  ChatCompletionResult,
  ChatStreamEvent,
  TokenUsage,
} from "@forge/shared";
import { assertOk, parseSseStream, readErrorBody } from "./sse.js";
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
 * Adapter for OpenAI-compatible chat completions APIs.
 * Used by: openai, openrouter, custom-http. No provider instance is ever
 * preconfigured — this class only runs against user-registered endpoints.
 */
export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly compatibility: ProviderConfig["compatibility"];

  constructor(protected readonly config: ProviderConfig) {
    this.compatibility = config.compatibility;
  }

  private headers(): Record<string, string> {
    return buildAuthHeaders(this.config);
  }

  async testConnection(signal?: AbortSignal): Promise<ConnectionTestResult> {
    const started = Date.now();
    const models = await this.discoverModels(signal);
    return {
      ok: true,
      latencyMs: Date.now() - started,
      detail: `Reached ${new URL(this.config.baseUrl).origin}; /models returned ${models.length} model(s)`,
      discoveredModels: models.length,
    };
  }

  async discoverModels(signal?: AbortSignal): Promise<DiscoveredModel[]> {
    const res = await fetchWithTimeout(
      joinUrl(this.config.baseUrl, "/models"),
      { method: "GET", headers: this.headers() },
      this.config.timeoutMs,
      signal,
    );
    if (!res.ok) {
      const preview = await readErrorBody(res);
      assertOk(res, preview);
    }
    const json = (await res.json()) as { data?: Array<{ id?: string }> };
    const data = Array.isArray(json.data) ? json.data : [];
    return data.flatMap((m) => (typeof m.id === "string" && m.id ? [{ modelId: m.id }] : []));
  }

  private requestBody(params: ChatCompletionParams, stream: boolean) {
    const messages = params.messages.map((m) => {
      if (m.role === "tool") {
        return { role: "tool", content: m.content, tool_call_id: m.toolCallId, ...(m.name ? { name: m.name } : {}) };
      }
      if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
        return {
          role: "assistant",
          content: m.content || null,
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.function.name, arguments: tc.function.arguments },
          })),
        };
      }
      return { role: m.role, content: m.content };
    });
    const body: Record<string, unknown> = {
      model: params.model,
      messages,
      temperature: params.temperature,
      max_tokens: params.maxTokens,
      stream,
    };
    if (stream) {
      body["stream_options"] = { include_usage: true };
    }
    if (params.tools && params.tools.length > 0) {
      body["tools"] = params.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
    }
    if (params.responseFormat === "json") {
      body["response_format"] = { type: "json_object" };
    }
    return body;
  }

  async chatCompletion(params: ChatCompletionParams): Promise<ChatCompletionResult> {
    const started = Date.now();
    const res = await fetchWithTimeout(
      joinUrl(this.config.baseUrl, "/chat/completions"),
      { method: "POST", headers: this.headers(), body: JSON.stringify(this.requestBody(params, false)) },
      this.config.timeoutMs,
      params.signal,
    );
    if (!res.ok) {
      const preview = await readErrorBody(res);
      assertOk(res, preview);
    }
    const json = (await res.json()) as {
      model?: string;
      choices?: Array<{
        message?: { content?: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> };
        finish_reason?: string | null;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const choice = json.choices?.[0];
    const usage: TokenUsage = {
      promptTokens: json.usage?.prompt_tokens ?? null,
      completionTokens: json.usage?.completion_tokens ?? null,
      totalTokens: json.usage?.total_tokens ?? (json.usage?.prompt_tokens != null && json.usage?.completion_tokens != null
        ? json.usage.prompt_tokens + json.usage.completion_tokens
        : null),
    };
    return {
      content: choice?.message?.content ?? "",
      toolCalls: (choice?.message?.tool_calls ?? []).map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.function.name, arguments: tc.function.arguments },
      })),
      usage,
      finishReason: choice?.finish_reason ?? null,
      model: json.model ?? params.model,
      providerId: this.config.id,
      latencyMs: Date.now() - started,
      raw: json,
    };
  }

  async *chatCompletionStream(params: ChatCompletionParams): AsyncGenerator<ChatStreamEvent> {
    const res = await fetchWithTimeout(
      joinUrl(this.config.baseUrl, "/chat/completions"),
      { method: "POST", headers: this.headers(), body: JSON.stringify(this.requestBody(params, true)) },
      this.config.timeoutMs,
      params.signal,
    );
    if (!res.ok) {
      const preview = await readErrorBody(res);
      assertOk(res, preview);
    }
    if (!res.body) {
      throw ForgeError.provider("Provider returned an empty stream body", 502);
    }
    const toolAccum = new Map<number, { id?: string; name?: string; arguments: string }>();
    let finishReason: string | null = null;
    let usage: TokenUsage = { promptTokens: null, completionTokens: null, totalTokens: null };
    for await (const data of parseSseStream(res.body)) {
      if (data === "[DONE]") break;
      let event: {
        choices?: Array<{
          delta?: {
            content?: string | null;
            tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>;
          };
          finish_reason?: string | null;
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
      };
      try {
        event = JSON.parse(data);
      } catch {
        continue; // tolerate keep-alive payloads
      }
      if (event.usage) {
        usage = {
          promptTokens: event.usage.prompt_tokens ?? null,
          completionTokens: event.usage.completion_tokens ?? null,
          totalTokens: event.usage.total_tokens ?? null,
        };
        yield { type: "usage", usage };
      }
      const choice = event.choices?.[0];
      if (!choice) continue;
      if (choice.delta?.content) {
        yield { type: "delta", text: choice.delta.content };
      }
      for (const tc of choice.delta?.tool_calls ?? []) {
        const acc = toolAccum.get(tc.index) ?? { arguments: "" };
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name = tc.function.name;
        if (tc.function?.arguments) acc.arguments += tc.function.arguments;
        toolAccum.set(tc.index, acc);
        yield {
          type: "tool_call_delta",
          index: tc.index,
          id: tc.id,
          name: tc.function?.name,
          argumentsDelta: tc.function?.arguments,
        };
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
    yield { type: "done", finishReason };
  }
}
