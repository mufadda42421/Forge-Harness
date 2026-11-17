import { Router } from "express";
import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { schema } from "@forge/database";
import type { AppContext } from "../context.js";
import { asyncRoute, parseBody } from "../http.js";

const runSchema = z.object({
  modelRowIds: z.array(z.string().min(1)).min(2).max(8),
  prompt: z.string().min(1).max(100_000),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(200_000).optional(),
});

export function arenaRoutes(ctx: AppContext): Router {
  const router = Router();

  /** Run one prompt against multiple registered models concurrently. */
  router.post("/run", asyncRoute(async (req, res) => {
    const body = parseBody(runSchema, req.body);
    const ac = new AbortController();
    res.on("close", () => { if (!res.writableEnded) ac.abort(); });

    const results = await Promise.all(body.modelRowIds.map(async (modelRowId) => {
      const model = (await ctx.db.select().from(schema.models).where(eq(schema.models.id, modelRowId)).limit(1))[0];
      const provider = model
        ? (await ctx.db.select().from(schema.providers).where(eq(schema.providers.id, model.providerId)).limit(1))[0]
        : undefined;
      try {
        const result = await ctx.router.chat({
          modelRowId,
          messages: [{ role: "user", content: body.prompt }],
          temperature: body.temperature,
          maxTokens: body.maxTokens,
          signal: ac.signal,
        });
        return {
          modelRowId,
          modelName: model?.displayName ?? modelRowId,
          providerName: provider?.name ?? null,
          status: "success" as const,
          content: result.content,
          usage: result.usage,
          latencyMs: result.latencyMs,
          estimatedCostUsd: result.estimatedCostUsd,
        };
      } catch (err) {
        return {
          modelRowId,
          modelName: model?.displayName ?? modelRowId,
          providerName: provider?.name ?? null,
          status: "error" as const,
          error: err instanceof Error ? err.message : String(err),
          usage: null,
          latencyMs: null,
          estimatedCostUsd: null,
        };
      }
    }));

    res.json({ results });
  }));

  /** Optional LLM-as-judge comparison using a user-selected evaluator model. */
  router.post("/judge", asyncRoute(async (req, res) => {
    const body = parseBody(z.object({
      judgeModelRowId: z.string().min(1),
      prompt: z.string().min(1).max(100_000),
      candidates: z.array(z.object({
        modelName: z.string(),
        content: z.string().max(100_000),
      })).min(2).max(8),
    }), req.body);
    const verdict = await ctx.router.chat({
      modelRowId: body.judgeModelRowId,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: "You are an impartial evaluator. Score each candidate on correctness, completeness and instruction adherence (0-10 each) and state a winner. Be explicit that these are subjective model-judged scores, not objective ground truth.",
        },
        {
          role: "user",
          content: [
            `Task:\n${body.prompt}`,
            "",
            ...body.candidates.map((c, i) => `### Candidate ${i + 1} — ${c.modelName}\n${c.content}`),
          ].join("\n"),
        },
      ],
    });
    res.json({
      verdict: verdict.content,
      judgeModelRowId: body.judgeModelRowId,
      methodology: "llm-as-judge (subjective; model-dependent). Manual scoring remains the default.",
      usage: verdict.usage,
      estimatedCostUsd: verdict.estimatedCostUsd,
    });
  }));

  /** Save an arena session for later comparison. */
  router.post("/sessions", asyncRoute(async (req, res) => {
    const body = parseBody(z.object({
      prompt: z.string().min(1).max(100_000),
      config: z.record(z.unknown()).default({}),
      results: z.array(z.record(z.unknown())).default([]),
    }), req.body);
    const row = ctx.db.insert(schema.arenaSessions).values({
      prompt: body.prompt,
      configJson: JSON.stringify(body.config),
      resultsJson: JSON.stringify(body.results),
    }).returning().all()[0]!;
    res.status(201).json({ session: row });
  }));

  router.get("/sessions", asyncRoute(async (_req, res) => {
    const rows = await ctx.db.select().from(schema.arenaSessions).orderBy(desc(schema.arenaSessions.createdAt)).limit(50);
    res.json({
      sessions: rows.map((r) => ({
        ...r,
        config: safeParse(r.configJson),
        results: safeParse(r.resultsJson),
      })),
    });
  }));

  router.delete("/sessions/:id", asyncRoute(async (req, res) => {
    ctx.db.delete(schema.arenaSessions).where(eq(schema.arenaSessions.id, req.params.id!)).run();
    res.json({ ok: true });
  }));

  return router;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
