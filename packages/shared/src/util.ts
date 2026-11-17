export function newId(): string {
  return crypto.randomUUID();
}

export function nowMs(): number {
  return Date.now();
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Truncate a string for logs/previews without throwing on weird input. */
export function truncate(value: string, max = 500): string {
  return value.length > max ? value.slice(0, max) + "…" : value;
}
