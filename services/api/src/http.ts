import type { NextFunction, Request, RequestHandler, Response } from "express";
import { z } from "zod";
import { ForgeError, errorBody } from "@forge/shared";

/** Wrap async handlers so rejections reach the error middleware. */
export function asyncRoute(
  handler: (req: Request, res: Response) => Promise<unknown>,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };
}

/** Parse and validate a JSON body; throws ForgeError(400) on failure. */
export function parseBody<S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw ForgeError.validation(
      "Request body failed validation",
      result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return result.data;
}

/** Parse and validate query params; throws ForgeError(400) on failure. */
export function parseQuery<S extends z.ZodTypeAny>(schema: S, query: unknown): z.infer<S> {
  const result = schema.safeParse(query);
  if (!result.success) {
    throw ForgeError.validation(
      "Query parameters failed validation",
      result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return result.data;
}

/** Express error middleware: normalized, redacted error responses. */
export function errorMiddleware(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const status = err instanceof ForgeError ? err.statusCode : 500;
  const body = errorBody(err);
  if (status >= 500) {
    console.error(`[forge] ${status}:`, body.error.message);
  }
  res.status(status).json(body);
}

/** Tiny request logger; never logs bodies (screenshots of secrets avoided). */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const started = Date.now();
  res.on("finish", () => {
    console.log(`[forge] ${req.method} ${req.originalUrl} -> ${res.statusCode} ${Date.now() - started}ms`);
  });
  next();
}
