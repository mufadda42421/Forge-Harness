import { Router } from "express";
import { z } from "zod";
import type { Request, Response } from "express";
import type { AppContext } from "../context.js";
import { asyncRoute, parseBody } from "../http.js";
import { ForgeError } from "@forge/shared";

const chatSchema = z.object({
  modelRowId: z.string().min(1),
  messages: z.array(z.object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z.string().max(200_000),
    toolCallId: z.string().optional(),
    name: z.string().optional(),
  })).min(1).max(200),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(200_000).optional(),
  responseFormat: z.enum(["text", "json"]).optional(),
});

function sseWrite(res: Response, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function inferenceRoutes(ctx: AppContext): Router {
  const router = Router();

  /** Non-streaming chat completion against a registered model. */
  router.post("/chat", asyncRoute(async (req, res) => {
    const body = parseBody(chatSchema, req.body);
    const ac = new AbortController();
    res.on("close", () => { if (!res.writableEnded) ac.abort(); });
    const result = await ctx.router.chat({ ...body, signal: ac.signal });
    res.json({ result: {
      content: result.content,
      toolCalls: result.toolCalls,
      finishReason: result.finishReason,
      model: result.model,
      usage: result.usage,
      latencyMs: result.latencyMs,
      estimatedCostUsd: result.estimatedCostUsd,
      costIsEstimated: result.costIsEstimated,
    } });
  }));

  /** SSE streaming chat completion. */
  router.post("/chat/stream", asyncRoute(async (req: Request, res: Response) => {
    const body = parseBody(chatSchema, req.body);
    const ac = new AbortController();
    res.on("close", () => { if (!res.writableEnded) ac.abort(); });

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      "connection": "keep-alive",
      "x-accel-buffering": "no",
    });
    res.flushHeaders?.();

    try {
      for await (const event of ctx.router.chatStream({ ...body, signal: ac.signal })) {
        sseWrite(res, event.type, event);
        if (event.type === "done") break;
      }
      sseWrite(res, "end", {});
      res.end();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof ForgeError ? err.code : "PROVIDER_ERROR";
      sseWrite(res, "error", { code, message });
      res.end();
    }
  }));

  return router;
}
