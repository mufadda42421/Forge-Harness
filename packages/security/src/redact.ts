/** Secret redaction for logs, error messages and tool outputs. */

const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /AIza[A-Za-z0-9_-]{20,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /x-api-key:\s*\S+/gi,
  /Authorization:\s*\S+/gi,
  /"(api[_-]?key|apikey|secret|token|password|authorization)"\s*:\s*"[^"]*"/gi,
];

export function redactSecrets(input: string): string {
  let out = input;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match) => (match.startsWith("Bearer") || match.startsWith("Authorization") ? match.split(" ")[0] + " [REDACTED]" : "[REDACTED]"));
  }
  return out;
}

/** Deep clone + redact any string fields that look like secrets. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[REDACTED]";
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (/key|secret|token|password|authorization/i.test(k)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = redactValue(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}
