export type ForgeErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PROVIDER_ERROR"
  | "PROVIDER_UNREACHABLE"
  | "PROVIDER_AUTH"
  | "PROVIDER_RATE_LIMIT"
  | "PROVIDER_TIMEOUT"
  | "MODEL_NOT_AVAILABLE"
  | "CAPABILITY_MISMATCH"
  | "CREDENTIAL_ERROR"
  | "EXECUTION_ERROR"
  | "EXECUTION_LIMIT"
  | "APPROVAL_REQUIRED"
  | "CANCELLED"
  | "WORKFLOW_INVALID"
  | "INTERNAL_ERROR";

export class ForgeError extends Error {
  readonly code: ForgeErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(code: ForgeErrorCode, message: string, statusCode = 500, details?: unknown) {
    super(message);
    this.name = "ForgeError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }

  static validation(message: string, details?: unknown) {
    return new ForgeError("VALIDATION_ERROR", message, 400, details);
  }
  static notFound(what: string) {
    return new ForgeError("NOT_FOUND", `${what} not found`, 404);
  }
  static conflict(message: string) {
    return new ForgeError("CONFLICT", message, 409);
  }
  static provider(message: string, statusCode = 502, details?: unknown) {
    return new ForgeError("PROVIDER_ERROR", message, statusCode, details);
  }
  static providerUnreachable(message: string, details?: unknown) {
    return new ForgeError("PROVIDER_UNREACHABLE", message, 502, details);
  }
  static providerAuth(message: string) {
    return new ForgeError("PROVIDER_AUTH", message, 502);
  }
  static providerRateLimit(message: string) {
    return new ForgeError("PROVIDER_RATE_LIMIT", message, 429);
  }
  static internal(message: string, details?: unknown) {
    return new ForgeError("INTERNAL_ERROR", message, 500, details);
  }
}

export function errorBody(err: unknown): { error: { code: string; message: string; details?: unknown } } {
  if (err instanceof ForgeError) {
    return { error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) } };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { error: { code: "INTERNAL_ERROR", message } };
}
