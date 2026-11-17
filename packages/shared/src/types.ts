/** Usage accounting as reported by the provider. Never fabricated. */
export interface TokenUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

export const UNKNOWN_USAGE: TokenUsage = { promptTokens: null, completionTokens: null, totalTokens: null };

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  name?: string;
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool input. */
  inputSchema: Record<string, unknown>;
}

export interface ChatCompletionParams {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  tools?: ToolSpec[];
  responseFormat?: "text" | "json";
  signal?: AbortSignal;
}

export interface ChatCompletionResult {
  content: string;
  toolCalls: ToolCall[];
  usage: TokenUsage;
  finishReason: string | null;
  model: string;
  providerId: string;
  latencyMs: number;
  /** Raw provider response for inspection; kept server-side only. */
  raw?: unknown;
}

export type ChatStreamEvent =
  | { type: "delta"; text: string }
  | { type: "tool_call_delta"; index: number; id?: string; name?: string; argumentsDelta?: string }
  | { type: "usage"; usage: TokenUsage }
  | { type: "done"; finishReason: string | null }
  | { type: "error"; message: string; code: string };

export interface ModelPricing {
  /** USD per 1M prompt tokens. Null = unknown. */
  inputCostPer1M: number | null;
  /** USD per 1M completion tokens. Null = unknown. */
  outputCostPer1M: number | null;
}

/**
 * Estimate cost in USD from user-configured pricing. Returns null when any
 * required value is unknown — never invents a price.
 */
export function estimateCostUsd(usage: TokenUsage, pricing: ModelPricing): number | null {
  const inRate = pricing.inputCostPer1M;
  const outRate = pricing.outputCostPer1M;
  if (inRate === null || outRate === null) return null;
  if (usage.promptTokens === null || usage.completionTokens === null) return null;
  return (usage.promptTokens / 1_000_000) * inRate + (usage.completionTokens / 1_000_000) * outRate;
}

/** Provider capability flags. `unknown` is represented by absence/null, never assumed true. */
export type ProviderCompatibility =
  | "openai"
  | "anthropic"
  | "google"
  | "ollama"
  | "openrouter"
  | "custom-http";

export type AuthMethod = "bearer" | "x-api-key" | "x-goog-api-key" | "none" | "custom";

export type ModelCapability =
  | "text"
  | "reasoning"
  | "tool_calling"
  | "structured_output"
  | "vision"
  | "image_generation"
  | "audio_input"
  | "audio_output"
  | "embeddings";

export const ALL_MODEL_CAPABILITIES: ModelCapability[] = [
  "text",
  "reasoning",
  "tool_calling",
  "structured_output",
  "vision",
  "image_generation",
  "audio_input",
  "audio_output",
  "embeddings",
];
