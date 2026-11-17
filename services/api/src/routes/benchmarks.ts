import { Router } from "express";
import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { schema } from "@forge/database";
import { ForgeError } from "@forge/shared";
import { runBenchmark } from "@forge/core";
import type { AppContext } from "../context.js";
import { asyncRoute, parseBody } from "../http.js";
import { audit } from "../audit.js";

export function benchmarksRoutes(ctx: AppContext): Router {
  const router = Router();

  /* suites */
  router.get("/suites", asyncRoute(async (_req, res) => {
    const suites = await ctx.db.select().from(schema.benchmarkSuites).orderBy(desc(schema.benchmarkSuites.updatedAt));
    const cases = await ctx.db.select().from(schema.benchmarkCases);
    const caseCount = new Map<string, number>();
    for (const c of cases) caseCount.set(c.suiteId, (caseCount.get(c.suiteId) ?? 0) + 1);
    res.json({ suites: suites.map((s) => ({ ...s, caseCount: caseCount.get(s.id) ?? 0 })) });
  }));

  router.post("/suites", asyncRoute(async (req, res) => {
    const body = parseBody(z.object({
      name: z.string().trim().min(1).max(160),
      description: z.string().max(2000).default(""),
    }), req.body);
    const created = ctx.db.insert(schema.benchmarkSuites).values(body).returning().all()[0]!;
    audit(ctx, "benchmark.suite_create", created.name, {});
    res.status(201).json({ suite: created });
  }));

  router.delete("/suites/:id", asyncRoute(async (req, res) => {
    ctx.db.delete(schema.benchmarkSuites).where(eq(schema.benchmarkSuites.id, req.params.id!)).run();
    audit(ctx, "benchmark.suite_delete", req.params.id!, {});
    res.json({ ok: true });
  }));

  /* cases */
  router.get("/suites/:id/cases", asyncRoute(async (req, res) => {
    const cases = await ctx.db.select().from(schema.benchmarkCases).where(eq(schema.benchmarkCases.suiteId, req.params.id!));
    res.json({ cases });
  }));

  router.post("/suites/:id/cases", asyncRoute(async (req, res) => {
    const body = parseBody(z.object({
      name: z.string().trim().min(1).max(160),
      prompt: z.string().min(1).max(100_000),
      expectedSubstring: z.string().max(10_000).nullable().optional(),
      expectedRegex: z.string().max(2_000).nullable().optional(),
    }), req.body);
    const suite = (await ctx.db.select().from(schema.benchmarkSuites).where(eq(schema.benchmarkSuites.id, req.params.id!)).limit(1))[0];
    if (!suite) throw ForgeError.notFound("Suite");
    if (body.expectedRegex) {
      try {
        new RegExp(body.expectedRegex);
      } catch {
        throw ForgeError.validation("expectedRegex is not a valid regular expression");
      }
    }
    const created = ctx.db.insert(schema.benchmarkCases).values({
      suiteId: suite.id,
      name: body.name,
      prompt: body.prompt,
      expectedSubstring: body.expectedSubstring ?? null,
      expectedRegex: body.expectedRegex ?? null,
    }).returning().all()[0]!;
    audit(ctx, "benchmark.case_create", created.name, { suiteId: suite.id });
    res.status(201).json({ case: created });
  }));

  router.delete("/cases/:id", asyncRoute(async (req, res) => {
    ctx.db.delete(schema.benchmarkCases).where(eq(schema.benchmarkCases.id, req.params.id!)).run();
    res.json({ ok: true });
  }));

  /* runs */
  router.post("/suites/:id/run", asyncRoute(async (req, res) => {
    const body = parseBody(z.object({
      modelRowIds: z.array(z.string().min(1)).min(1).max(8),
      repeatCount: z.number().int().min(1).max(10).default(1),
    }), req.body);
    const suite = (await ctx.db.select().from(schema.benchmarkSuites).where(eq(schema.benchmarkSuites.id, req.params.id!)).limit(1))[0];
    if (!suite) throw ForgeError.notFound("Suite");
    const cases = await ctx.db.select().from(schema.benchmarkCases).where(eq(schema.benchmarkCases.suiteId, suite.id));
    if (cases.length === 0) throw ForgeError.validation("Suite has no test cases. Add at least one case first.");
    const ac = new AbortController();
    res.on("close", () => { if (!res.writableEnded) ac.abort(); });
    const summary = await runBenchmark(ctx.db, ctx.router, {
      suiteId: suite.id,
      modelRowIds: body.modelRowIds,
      repeatCount: body.repeatCount,
      signal: ac.signal,
    });
    audit(ctx, "benchmark.run", suite.name, { ...summary });
    res.json(summary);
  }));

  router.get("/runs", asyncRoute(async (req, res) => {
    const suiteId = typeof req.query.suiteId === "string" ? req.query.suiteId : undefined;
    const base = ctx.db.select().from(schema.benchmarkRuns).orderBy(desc(schema.benchmarkRuns.createdAt)).limit(50);
    const rows = suiteId ? await ctx.db.select().from(schema.benchmarkRuns).where(eq(schema.benchmarkRuns.suiteId, suiteId)).orderBy(desc(schema.benchmarkRuns.createdAt)).limit(50) : await base;
    res.json({ runs: rows });
  }));

  router.get("/runs/:id", asyncRoute(async (req, res) => {
    const rows = await ctx.db.select().from(schema.benchmarkRuns).where(eq(schema.benchmarkRuns.id, req.params.id!));
    if (rows.length === 0) throw ForgeError.notFound("Benchmark run");
    const results = await ctx.db.select().from(schema.benchmarkResults).where(eq(schema.benchmarkResults.runId, req.params.id!));

    const byModel = new Map<string, typeof results>();
    for (const r of results) {
      const list = byModel.get(r.modelRowId) ?? [];
      list.push(r);
      byModel.set(r.modelRowId, list);
    }
    const aggregate = [...byModel.entries()].map(([modelRowId, rs]) => {
      const latencies = rs.map((r) => r.latencyMs).filter((x): x is number => x != null).sort((a, b) => a - b);
      const determinate = rs.filter((r) => r.passed !== null);
      const sorted = latencies;
      const medianLatency = sorted.length === 0 ? null : sorted.length % 2 === 1 ? sorted[(sorted.length - 1) / 2]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
      return {
        modelRowId,
        samples: rs.length,
        successRate: determinate.length ? determinate.filter((r) => r.passed).length / determinate.length : null,
        errorCount: rs.filter((r) => r.error).length,
        avgLatencyMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
        medianLatencyMs: medianLatency,
        minLatencyMs: latencies[0] ?? null,
        maxLatencyMs: latencies[latencies.length - 1] ?? null,
        totalTokens: rs.reduce((acc, r) => acc + (r.totalTokens ?? 0), 0),
        estimatedCostUsd: rs.every((r) => r.estimatedCostUsd === null) ? null : rs.reduce((acc, r) => acc + (r.estimatedCostUsd ?? 0), 0),
      };
    });
    res.json({ run: rows[0], results, aggregate });
  }));

  router.get("/runs/:id/export", asyncRoute(async (req, res) => {
    const rows = await ctx.db.select().from(schema.benchmarkRuns).where(eq(schema.benchmarkRuns.id, req.params.id!));
    if (rows.length === 0) throw ForgeError.notFound("Benchmark run");
    const results = await ctx.db.select().from(schema.benchmarkResults).where(eq(schema.benchmarkResults.runId, req.params.id!));
    res.setHeader("content-type", "application/json");
    res.setHeader("content-disposition", `attachment; filename="forge-benchmark-${req.params.id}.json"`);
    res.send(JSON.stringify({ run: rows[0], results, exportedAt: new Date().toISOString() }, null, 2));
  }));

  return router;
}
