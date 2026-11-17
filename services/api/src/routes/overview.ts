import { Router } from "express";
import { count, sql, desc } from "drizzle-orm";
import { schema } from "@forge/database";
import type { AppContext } from "../context.js";
import { asyncRoute } from "../http.js";

/** Aggregated first-paint data for the Overview dashboard. All values are measured from the DB. */
export function overviewRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get("/", asyncRoute(async (_req, res) => {
    const providerStats = ctx.db.select({
      total: count(),
      ok: sql<number>`sum(case when ${schema.providers.connectionStatus} = 'ok' then 1 else 0 end)`,
      enabled: sql<number>`sum(case when ${schema.providers.enabled} then 1 else 0 end)`,
    }).from(schema.providers).all()[0];

    const modelStats = ctx.db.select({ total: count(), enabled: sql<number>`sum(case when ${schema.models.enabled} then 1 else 0 end)` })
      .from(schema.models).all()[0];

    const agentStats = ctx.db.select({ total: count(), enabled: sql<number>`sum(case when ${schema.agents.enabled} then 1 else 0 end)` })
      .from(schema.agents).all()[0];

    const runningWorkflows = ctx.db.select({ c: count() }).from(schema.workflowExecutions)
      .where(sql`${schema.workflowExecutions.status} = 'running'`).all()[0];

    const awaitingApprovals = ctx.db.select({ c: count() }).from(schema.workflowExecutions)
      .where(sql`${schema.workflowExecutions.status} = 'awaiting_approval'`).all()[0];

    const recentRequests = await ctx.db.select().from(schema.modelRequests).orderBy(desc(schema.modelRequests.createdAt)).limit(8);
    const recentErrors = await ctx.db.select().from(schema.modelRequests)
      .where(sql`${schema.modelRequests.status} = 'error'`)
      .orderBy(desc(schema.modelRequests.createdAt))
      .limit(5);

    const requestAgg = ctx.db.select({
      total: count(),
      avgLatencyMs: sql<number>`avg(${schema.modelRequests.latencyMs})`,
    }).from(schema.modelRequests).all()[0];

    const usageAgg = ctx.db.select({
      totalTokens: sql<number>`sum(${schema.usageRecords.totalTokens})`,
      estCost: sql<number>`sum(${schema.usageRecords.estimatedCostUsd})`,
    }).from(schema.usageRecords).all()[0];

    res.json({
      providers: { total: Number(providerStats?.total ?? 0), connected: Number(providerStats?.ok ?? 0), enabled: Number(providerStats?.enabled ?? 0) },
      models: { total: Number(modelStats?.total ?? 0), enabled: Number(modelStats?.enabled ?? 0) },
      agents: { total: Number(agentStats?.total ?? 0), enabled: Number(agentStats?.enabled ?? 0) },
      executions: { runningWorkflows: Number(runningWorkflows?.c ?? 0), awaitingApprovals: Number(awaitingApprovals?.c ?? 0) },
      totals: {
        requests: Number(requestAgg?.total ?? 0),
        avgLatencyMs: requestAgg?.avgLatencyMs != null ? Math.round(Number(requestAgg.avgLatencyMs)) : null,
        tokens: usageAgg?.totalTokens != null ? Number(usageAgg.totalTokens) : 0,
        /** Always an estimate from user-configured pricing — never an invoice. */
        estimatedCostUsd: usageAgg?.estCost != null ? Number(usageAgg.estCost) : null,
      },
      recentRequests,
      recentErrors,
      firstRun: Number(providerStats?.total ?? 0) === 0,
    });
  }));

  return router;
}

export function healthRoutes(ctx: AppContext): Router {
  const router = Router();
  router.get("/", asyncRoute(async (_req, res) => {
    // Touch the DB to prove liveness
    ctx.db.select({ ok: count() }).from(schema.providers).all();
    res.json({
      ok: true,
      service: "forge-harness-api",
      version: "0.1.0",
      uptimeSeconds: Math.round((Date.now() - ctx.startedAt) / 1000),
      loopbackOnly: true,
    });
  }));
  return router;
}
