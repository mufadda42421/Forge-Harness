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

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: unknown };
  functionResponse?: { name: string; response: unknown };
}

function toGeminiContents(messages: ChatMessage[]): {
  systemInstruction: { parts: Array<{ text: string }> } | undefined;
  contents: Array<{ role: "user" | "model"; parts: GeminiPart[] }>;
} {
  const systemParts: Array<{ text: string }> = [];
  const contents: Array<{ role: "user" | "model"; parts: GeminiPart[] }> = [];
  for (const msg of messages) {
    if (msg.role === "system") {
      systemParts.push({ text: msg.content });
      continue;
    }
    if (msg.role === "tool") {
      contents.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name: msg.name ?? msg.toolCallId ?? "tool",
              response: { result: msg.content },
            },
          },
        ],
      });
      continue;
    }
    if (msg.role === "assistant") {
      const parts: GeminiPart[] = [];
      if (msg.content) parts.push({ text: msg.content });
      for (const tc of msg.toolCalls ?? []) {
        let args: unknown = {};
        try {
          args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch {
          args = {};
        }
        parts.push({ functionCall: { name: tc.function.name, args } });
      }
      contents.push({ role: "model", parts: parts.length ? parts : [{ text: "" }] });
      continue;
    }
    contents.push({ role: "user", parts: [{ text: msg.content }] });
  }
  return {
    systemInstruction: systemParts.length ? { parts: systemParts } : undefined,
    contents,
  };
}

/** Adapter for Google Gemini APIs (generativelanguage.googleapis.com style). */
export class GoogleGeminiAdapter implements ProviderAdapter {
  readonly compatibility = "google" as const;

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
      detail: `Reached Gemini /v1beta/models; returned ${models.length} model(s)`,
      discoveredModels: models.length,
    };
  }

  async discoverModels(signal?: AbortSignal): Promise<DiscoveredModel[]> {
    const res = await fetchWithTimeout(
      joinUrl(this.config.baseUrl, "/v1beta/models"),
      { method: "GET", headers: this.headers() },
      this.config.timeoutMs,
      signal,
    );
    if (!res.ok) {
      const preview = await readErrorBody(res);
      assertOk(res, preview);
    }
    const json = (await res.json()) as {
      models?: Array<{ name?: string; displayName?: string; inputTokenLimit?: number }>;
    };
    return (json.models ?? []).flatMap((m) => {
      if (!m.name) return [];
      const modelId = m.name.replace(/^models\//, "");
      return [{
        modelId,
        displayName: m.displayName,
        contextWindow: typeof m.inputTokenLimit === "number" ? m.inputTokenLimit : undefined,
      }];
    });
  }

  private requestBody(params: ChatCompletionParams): Record<string, unknown> {
    const { systemInstruction, contents } = toGeminiContents(params.messages);
    const generationConfig: Record<string, unknown> = {};
    if (params.temperature !== undefined) generationConfig["temperature"] = params.temperature;
    if (params.maxTokens !== undefined) generationConfig["maxOutputTokens"] = params.maxTokens;
    if (params.responseFormat === "json") generationConfig["responseMimeType"] = "application/json";
    const body: Record<string, unknown> = { contents, generationConfig };
    if (systemInstruction) body["systemInstruction"] = systemInstruction;
    if (params.tools && params.tools.length > 0) {
      body["tools"] = [
        {
          functionDeclarations: params.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
          })),
        },
      ];
    }
    return body;
  }

  private parseCandidate(json: {
    candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
  }) {
    const textParts: string[] = [];
    const toolCalls: ChatCompletionResult["toolCalls"] = [];
    const parts = json.candidates?.[0]?.content?.parts ?? [];
    for (const part of parts) {
      if (part.text) textParts.push(part.text);
      if (part.functionCall) {
        toolCalls.push({
          id: `call_${toolCalls.length}_${Date.now()}`,
          type: "function" as const,
          function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args ?? {}) },
        });
      }
    }
    const usage: TokenUsage = {
      promptTokens: json.usageMetadata?.promptTokenCount ?? null,
      completionTokens: json.usageMetadata?.candidatesTokenCount ?? null,
      totalTokens: json.usageMetadata?.totalTokenCount ?? null,
    };
    return { text: textParts.join(""), toolCalls, usage, finishReason: json.candidates?.[0]?.finishReason ?? null };
  }

  async chatCompletion(params: ChatCompletionParams): Promise<ChatCompletionResult> {
    const started = Date.now();
    const res = await fetchWithTimeout(
      joinUrl(this.config.baseUrl, `/v1beta/models/${encodeURIComponent(params.model)}:generateContent`),
      { method: "POST", headers: this.headers(), body: JSON.stringify(this.requestBody(params)) },
      this.config.timeoutMs,
      params.signal,
    );
    if (!res.ok) {
      const preview = await readErrorBody(res);
      assertOk(res, preview);
    }
    const json = await res.json() as Parameters<GoogleGeminiAdapter["parseCandidate"]>[0];
    const parsed = this.parseCandidate(json);
    return {
      content: parsed.text,
      toolCalls: parsed.toolCalls,
      usage: parsed.usage,
      finishReason: parsed.finishReason,
      model: params.model,
      providerId: this.config.id,
      latencyMs: Date.now() - started,
      raw: json,
    };
  }

  async *chatCompletionStream(params: ChatCompletionParams): AsyncGenerator<ChatStreamEvent> {
    const res = await fetchWithTimeout(
      joinUrl(this.config.baseUrl, `/v1beta/models/${encodeURIComponent(params.model)}:streamGenerateContent?alt=sse`),
      { method: "POST", headers: this.headers(), body: JSON.stringify(this.requestBody(params)) },
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
    let finishReason: string | null = null;
    let usage: TokenUsage = { promptTokens: null, completionTokens: null, totalTokens: null };
    let toolIndex = 0;
    for await (const data of parseSseStream(res.body)) {
      let json: Parameters<GoogleGeminiAdapter["parseCandidate"]>[0];
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      const parsed = this.parseCandidate(json);
      if (parsed.text) yield { type: "delta", text: parsed.text };
      for (const tc of parsed.toolCalls) {
        yield { type: "tool_call_delta", index: toolIndex, id: tc.id, name: tc.function.name, argumentsDelta: tc.function.arguments };
        toolIndex += 1;
      }
      if (parsed.usage.totalTokens !== null || parsed.usage.promptTokens !== null) {
        usage = parsed.usage;
      }
      if (parsed.finishReason) finishReason = parsed.finishReason;
    }
    if (usage.totalTokens !== null || usage.promptTokens !== null) {
      yield { type: "usage", usage };
    }
    yield { type: "done", finishReason };
  }
}
