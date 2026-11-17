import { ForgeError } from "@forge/shared";
import type {
  ChatCompletionParams,
  ChatCompletionResult,
  ChatMessage,
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

const ANTHROPIC_VERSION = "2023-06-01";

interface AnthropicContentBlock {
  type: "text" | "tool_use" | "tool_result" | "thinking";
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

function toAnthropicMessages(messages: ChatMessage[]): { system: string | undefined; messages: AnthropicMessage[] } {
  const systemParts: string[] = [];
  const out: AnthropicMessage[] = [];
  for (const msg of messages) {
    if (msg.role === "system") {
      systemParts.push(msg.content);
      continue;
    }
    if (msg.role === "tool") {
      const block: AnthropicContentBlock = {
        type: "tool_result",
        tool_use_id: msg.toolCallId ?? "unknown",
        content: msg.content,
      };
      const last = out[out.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content)) {
        last.content.push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
      continue;
    }
    if (msg.role === "assistant") {
      if ((msg.toolCalls?.length ?? 0) > 0) {
        const blocks: AnthropicContentBlock[] = [];
        if (msg.content) blocks.push({ type: "text", text: msg.content });
        for (const tc of msg.toolCalls ?? []) {
          let input: unknown = {};
          try {
            input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
          } catch {
            input = {};
          }
          blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
        }
        out.push({ role: "assistant", content: blocks });
      } else {
        out.push({ role: "assistant", content: msg.content });
      }
      continue;
    }
    out.push({ role: "user", content: msg.content });
  }
  return { system: systemParts.length ? systemParts.join("\n\n") : undefined, messages: out };
}

/**
 * Adapter for Anthropic-compatible Messages APIs (api.anthropic.com style).
 * Requires the user to configure their own base URL and key.
 */
export class AnthropicAdapter implements ProviderAdapter {
  readonly compatibility = "anthropic" as const;

  constructor(private readonly config: ProviderConfig) {}

  private headers(): Record<string, string> {
    const h = buildAuthHeaders(this.config);
    h["anthropic-version"] = ANTHROPIC_VERSION;
    return h;
  }

  async testConnection(signal?: AbortSignal): Promise<ConnectionTestResult> {
    const started = Date.now();
    // Anthropic has no public /models list guaranteed for all compatible
    // gateways; use a minimal message probe instead. This makes zero-token
    // guarantees impossible, so we prefer the models endpoint and fall back.
    try {
      const res = await fetchWithTimeout(
        joinUrl(this.config.baseUrl, "/v1/models"),
        { method: "GET", headers: this.headers() },
        this.config.timeoutMs,
        signal,
      );
      if (res.ok) {
        return { ok: true, latencyMs: Date.now() - started, detail: "Reached Anthropic-compatible /v1/models" };
      }
    } catch {
      /* fall through to probe */
    }
    // Fallback: OPTIONS-style probe is not supported; report unreachable distinctly.
    throw ForgeError.provider(
      "Could not verify connection: /v1/models probe failed. Check base URL, key and network.",
      502,
    );
  }

  async discoverModels(signal?: AbortSignal): Promise<DiscoveredModel[]> {
    const res = await fetchWithTimeout(
      joinUrl(this.config.baseUrl, "/v1/models"),
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
    return data.flatMap((m) => (typeof m.id === "string" ? [{ modelId: m.id }] : []));
  }

  private requestBody(params: ChatCompletionParams, stream: boolean): Record<string, unknown> {
    const { system, messages } = toAnthropicMessages(params.messages);
    const body: Record<string, unknown> = {
      model: params.model,
      max_tokens: params.maxTokens ?? 4096,
      messages,
      stream,
    };
    if (system) body["system"] = system;
    if (params.temperature !== undefined) body["temperature"] = params.temperature;
    if (params.tools && params.tools.length > 0) {
      body["tools"] = params.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }));
    }
    return body;
  }

  async chatCompletion(params: ChatCompletionParams): Promise<ChatCompletionResult> {
    const started = Date.now();
    const res = await fetchWithTimeout(
      joinUrl(this.config.baseUrl, "/v1/messages"),
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
      content?: AnthropicContentBlock[];
      stop_reason?: string | null;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const textParts: string[] = [];
    const toolCalls: ChatCompletionResult["toolCalls"] = [];
    for (const block of json.content ?? []) {
      if (block.type === "text" && block.text) textParts.push(block.text);
      if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id ?? `toolu_${toolCalls.length}`,
          type: "function" as const,
          function: { name: block.name ?? "", arguments: JSON.stringify(block.input ?? {}) },
        });
      }
    }
    const inTok = json.usage?.input_tokens ?? null;
    const outTok = json.usage?.output_tokens ?? null;
    const usage: TokenUsage = {
      promptTokens: inTok,
      completionTokens: outTok,
      totalTokens: inTok !== null && outTok !== null ? inTok + outTok : null,
    };
    return {
      content: textParts.join(""),
      toolCalls,
      usage,
      finishReason: json.stop_reason ?? null,
      model: json.model ?? params.model,
      providerId: this.config.id,
      latencyMs: Date.now() - started,
      raw: json,
    };
  }

  async *chatCompletionStream(params: ChatCompletionParams): AsyncGenerator<ChatStreamEvent> {
    const res = await fetchWithTimeout(
      joinUrl(this.config.baseUrl, "/v1/messages"),
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
    // Anthropic SSE: named events; our parser yields only `data:` lines, which is sufficient.
    let finishReason: string | null = null;
    let promptTokens: number | null = null;
    let completionTokens: number | null = null;
    const toolAccum = new Map<number, { id?: string; name?: string; json: string }>();
    for await (const data of parseSseStream(res.body)) {
      let event: {
        type?: string;
        index?: number;
        content_block?: { type?: string; id?: string; name?: string };
        delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
        message?: { usage?: { input_tokens?: number } };
        usage?: { output_tokens?: number };
      };
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      switch (event.type) {
        case "message_start":
          promptTokens = event.message?.usage?.input_tokens ?? null;
          break;
        case "content_block_start":
          if (event.content_block?.type === "tool_use" && event.index !== undefined) {
            toolAccum.set(event.index, {
              id: event.content_block.id,
              name: event.content_block.name,
              json: "",
            });
            yield { type: "tool_call_delta", index: event.index, id: event.content_block.id, name: event.content_block.name };
          }
          break;
        case "content_block_delta":
          if (event.delta?.type === "text_delta" && event.delta.text) {
            yield { type: "delta", text: event.delta.text };
          } else if (event.delta?.type === "input_json_delta" && event.index !== undefined) {
            const acc = toolAccum.get(event.index) ?? { json: "" };
            acc.json += event.delta.partial_json ?? "";
            toolAccum.set(event.index, acc);
            yield { type: "tool_call_delta", index: event.index, argumentsDelta: event.delta.partial_json };
          }
          break;
        case "message_delta":
          if (event.delta?.stop_reason) finishReason = event.delta.stop_reason;
          if (event.usage?.output_tokens !== undefined) completionTokens = event.usage.output_tokens;
          break;
        case "message_stop":
          break;
        default:
          break;
      }
    }
    if (promptTokens !== null || completionTokens !== null) {
      yield {
        type: "usage",
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens !== null && completionTokens !== null ? promptTokens + completionTokens : null,
        },
      };
    }
    yield { type: "done", finishReason };
  }
}
