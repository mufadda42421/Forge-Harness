import { ForgeError } from "@forge/shared";

/**
 * Minimal SSE parser over a fetch Response body. Yields `data:` payloads.
 * Comment lines (starting with ':') and `event:` lines are tolerated.
 */
export async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of rawEvent.split("\n")) {
          const trimmed = line.replace(/\r$/, "");
          if (trimmed.startsWith("data:")) {
            yield trimmed.slice(5).trim();
          }
        }
      }
    }
    // flush trailing event without trailing blank line
    const trimmed = buffer.replace(/\r$/, "").trim();
    if (trimmed.startsWith("data:")) {
      yield trimmed.slice(5).trim();
    }
  } finally {
    reader.releaseLock();
  }
}

export async function readErrorBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 1000);
  } catch {
    return "<unreadable error body>";
  }
}

export function assertOk(res: Response, bodyPreview: string): void {
  if (res.ok) return;
  if (res.status === 401 || res.status === 403) {
    throw ForgeError.providerAuth(`Provider rejected credentials (HTTP ${res.status})`);
  }
  if (res.status === 429) {
    throw ForgeError.providerRateLimit("Provider rate limit exceeded (HTTP 429)");
  }
  if (res.status === 408) {
    throw new ForgeError("PROVIDER_TIMEOUT", "Provider request timed out (HTTP 408)", 504);
  }
  throw ForgeError.provider(`Provider returned HTTP ${res.status}: ${bodyPreview}`, 502);
}
