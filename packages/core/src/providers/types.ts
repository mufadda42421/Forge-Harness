import { ForgeError } from "@forge/shared";
import type {
  AuthMethod,
  ChatCompletionParams,
  ChatCompletionResult,
  ChatStreamEvent,
  ProviderCompatibility,
} from "@forge/shared";

export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  compatibility: ProviderCompatibility;
  authMethod: AuthMethod;
  /** Decrypted in-memory only. Null when the provider requires no auth (e.g. local Ollama). */
  apiKey: string | null;
  customHeaders: Record<string, string>;
  timeoutMs: number;
  maxRetries: number;
}

export interface DiscoveredModel {
  modelId: string;
  displayName?: string;
  contextWindow?: number;
}

export interface ConnectionTestResult {
  ok: boolean;
  latencyMs: number;
  detail?: string;
  discoveredModels?: number;
}

export interface ProviderAdapter {
  readonly compatibility: ProviderCompatibility;
  testConnection(signal?: AbortSignal): Promise<ConnectionTestResult>;
  discoverModels(signal?: AbortSignal): Promise<DiscoveredModel[]>;
  chatCompletion(params: ChatCompletionParams): Promise<ChatCompletionResult>;
  chatCompletionStream(params: ChatCompletionParams): AsyncGenerator<ChatStreamEvent>;
}

export function buildAuthHeaders(config: ProviderConfig): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json", ...config.customHeaders };
  if (!config.apiKey) return headers;
  switch (config.authMethod) {
    case "bearer":
      headers["authorization"] = `Bearer ${config.apiKey}`;
      break;
    case "x-api-key":
      headers["x-api-key"] = config.apiKey;
      break;
    case "x-goog-api-key":
      headers["x-goog-api-key"] = config.apiKey;
      break;
    case "none":
      break;
    case "custom":
      // custom auth: user supplies full header via customHeaders; key is ignored
      break;
  }
  return headers;
}

export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}

/** fetch with hard timeout; combines an external cancellation signal. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("timeout"));
  }, timeoutMs);
  const onAbort = () => controller.abort(signal?.reason ?? new Error("cancelled"));
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (timedOut) {
      throw new ForgeError("PROVIDER_TIMEOUT", `Provider request timed out after ${timeoutMs}ms`, 504);
    }
    if (signal?.aborted) {
      throw new ForgeError("CANCELLED", "Request cancelled", 499);
    }
    const message = err instanceof Error ? err.message : String(err);
    let origin = url;
    try {
      origin = new URL(url).origin;
    } catch {
      /* keep raw */
    }
    throw ForgeError.providerUnreachable(`Could not reach provider at ${origin}: ${message}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
