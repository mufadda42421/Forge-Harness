import { ForgeError } from "@forge/shared";

export interface SsrfGuardOptions {
  /**
   * Forge Harness intentionally allows private/loopback endpoints: local
   * model servers (e.g. Ollama on 127.0.0.1) are a first-class BYOK use case.
   * We block only the cloud-metadata range and non-HTTP(S) schemes.
   */
  allowPrivateNetwork?: boolean;
}

const BLOCKED_HOSTNAMES = new Set([
  "169.254.169.254", // AWS/GCP/Azure IMDS
  "metadata.google.internal",
]);

/** Validate a user-supplied base URL before any request is sent to it. */
export function assertUrlAllowed(rawUrl: string, options: SsrfGuardOptions = {}): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw ForgeError.validation(`Invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw ForgeError.validation("Only http:// and https:// endpoints are supported");
  }
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host)) {
    throw ForgeError.validation("This endpoint is blocked by the SSRF policy (cloud metadata service)");
  }
  // IPv4 link-local range 169.254.0.0/16
  if (/^169\.254\./.test(host)) {
    throw ForgeError.validation("Link-local endpoints are blocked by the SSRF policy");
  }
  if (!options.allowPrivateNetwork) {
    // strict mode retained for future per-setting enforcement
    if (/^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || host === "localhost") {
      throw ForgeError.validation("Private network endpoints are disabled by policy");
    }
  }
  return url;
}
