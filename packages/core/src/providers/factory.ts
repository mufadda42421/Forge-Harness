import type { ProviderCompatibility } from "@forge/shared";
import { ForgeError } from "@forge/shared";
import { AnthropicAdapter } from "./anthropic.js";
import { GoogleGeminiAdapter } from "./google.js";
import { OllamaAdapter } from "./ollama.js";
import { OpenAICompatibleAdapter } from "./openai-compatible.js";
import type { ProviderAdapter, ProviderConfig } from "./types.js";

export type { ProviderAdapter, ProviderConfig, DiscoveredModel, ConnectionTestResult } from "./types.js";
export { OpenAICompatibleAdapter } from "./openai-compatible.js";
export { AnthropicAdapter } from "./anthropic.js";
export { GoogleGeminiAdapter } from "./google.js";
export { OllamaAdapter } from "./ollama.js";

/** Build an adapter for a user-registered provider. Never called with a preconfigured provider. */
export function createAdapter(config: ProviderConfig): ProviderAdapter {
  switch (config.compatibility as ProviderCompatibility) {
    case "openai":
    case "openrouter":
    case "custom-http":
      // OpenRouter and custom HTTP endpoints speak the OpenAI chat-completions
      // dialect; OpenRouter-specific routing is configured by the user via
      // custom headers (e.g. HTTP-Referer) and their chosen model IDs.
      return new OpenAICompatibleAdapter(config);
    case "anthropic":
      return new AnthropicAdapter(config);
    case "google":
      return new GoogleGeminiAdapter(config);
    case "ollama":
      return new OllamaAdapter(config);
    default:
      throw ForgeError.validation(`Unsupported compatibility type: ${String(config.compatibility)}`);
  }
}
