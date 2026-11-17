import { Router } from "express";
import { eq, desc, count, sum, avg, sql, gte } from "drizzle-orm";
import { schema } from "@forge/database";
import type { AppContext } from "../context.js";
import { asyncRoute } from "../http.js";

export function analyticsRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get("/summary", asyncRoute(async (req, res) => {
    const days = Math.min(Math.max(Number(req.query.days ?? 30) || 30, 1), 3650);
    const since = Date.now() - days * 24 * 60 * 60 * 1000;

    const reqAgg = ctx.db
      .select({
        total: count(),
        succeeded: sql<number>`sum(case when ${schema.modelRequests.status} = 'success' then 1 else 0 end)`,
        failed: sql<number>`sum(case when ${schema.modelRequests.status} = 'error' then 1 else 0 end)`,
        avgLatencyMs: avg(schema.modelRequests.latencyMs),
      })
      .from(schema.modelRequests)
      .where(gte(schema.modelRequests.createdAt, since))
      .all()[0];

    const usageAgg = ctx.db
      .select({
        promptTokens: sum(schema.usageRecords.promptTokens),
        completionTokens: sum(schema.usageRecords.completionTokens),
        totalTokens: sum(schema.usageRecords.totalTokens),
        estimatedCostUsd: sum(schema.usageRecords.estimatedCostUsd),
      })
      .from(schema.usageRecords)
      .where(gte(schema.usageRecords.createdAt, since))
      .all()[0];

    const agentAgg = ctx.db
      .select({ total: count(), running: sql<number>`sum(case when ${schema.agentExecutions.status} = 'running' then 1 else 0 end)` })
      .from(schema.agentExecutions)
      .where(gte(schema.agentExecutions.createdAt, since))
      .all()[0];

    const workflowAgg = ctx.db
      .select({ total: count(), running: sql<number>`sum(case when ${schema.workflowExecutions.status} = 'running' then 1 else 0 end)` })
      .from(schema.workflowExecutions)
      .where(gte(schema.workflowExecutions.createdAt, since))
      .all()[0];

    const toolAgg = ctx.db.select({ total: count() }).from(schema.toolExecutionLogs).where(gte(schema.toolExecutionLogs.createdAt, since)).all()[0];

    res.json({
      periodDays: days,
      requests: {
        total: Number(reqAgg?.total ?? 0),
        succeeded: Number(reqAgg?.succeeded ?? 0),
        failed: Number(reqAgg?.failed ?? 0),
        avgLatencyMs: reqAgg?.avgLatencyMs != null ? Math.round(Number(reqAgg.avgLatencyMs)) : null,
      },
      tokens: {
        prompt: Number(usageAgg?.promptTokens ?? 0),
        completion: Number(usageAgg?.completionTokens ?? 0),
        total: Number(usageAgg?.totalTokens ?? 0),
        /** Provider-reported; never invented. */
        source: "provider-reported",
      },
      cost: {
        /** Estimated from user-configured pricing; not an invoice. */
        estimatedUsd: usageAgg?.estimatedCostUsd != null ? Number(usageAgg.estimatedCostUsd) : null,
        kind: "estimate",
      },
      agents: { total: Number(agentAgg?.total ?? 0), running: Number(agentAgg?.running ?? 0) },
      workflows: { total: Number(workflowAgg?.total ?? 0), running: Number(workflowAgg?.running ?? 0) },
      toolExecutions: { total: Number(toolAgg?.total ?? 0) },
    });
  }));

  router.get("/by-model", asyncRoute(async (req, res) => {
    const days = Math.min(Math.max(Number(req.query.days ?? 30) || 30, 1), 3650);
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    const rows = await ctx.db
      .select({
        modelRowId: schema.usageRecords.modelRowId,
        modelName: schema.models.displayName,
        providerName: schema.providers.name,
        requests: count(),
        totalTokens: sum(schema.usageRecords.totalTokens),
        estimatedCostUsd: sum(schema.usageRecords.estimatedCostUsd),
        avgLatencyMs: avg(schema.usageRecords.latencyMs),
      })
      .from(schema.usageRecords)
      .leftJoin(schema.models, eq(schema.usageRecords.modelRowId, schema.models.id))
      .leftJoin(schema.providers, eq(schema.usageRecords.providerId, schema.providers.id))
      .where(gte(schema.usageRecords.createdAt, since))
      .groupBy(schema.usageRecords.modelRowId)
      .all();
    res.json({ models: rows.map((r) => ({ ...r, avgLatencyMs: r.avgLatencyMs != null ? Math.round(Number(r.avgLatencyMs)) : null })) });
  }));

  router.get("/by-provider", asyncRoute(async (req, res) => {
    const days = Math.min(Math.max(Number(req.query.days ?? 30) || 30, 1), 3650);
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    const rows = await ctx.db
      .select({
        providerId: schema.usageRecords.providerId,
        providerName: schema.providers.name,
        requests: count(),
        totalTokens: sum(schema.usageRecords.totalTokens),
        estimatedCostUsd: sum(schema.usageRecords.estimatedCostUsd),
      })
      .from(schema.usageRecords)
      .leftJoin(schema.providers, eq(schema.usageRecords.providerId, schema.providers.id))
      .where(gte(schema.usageRecords.createdAt, since))
      .groupBy(schema.usageRecords.providerId)
      .all();
    res.json({ providers: rows });
  }));

  router.get("/agents", asyncRoute(async (_req, res) => {
    const rows = await ctx.db
      .select({
        agentId: schema.agentExecutions.agentId,
        executions: count(),
        succeeded: sql<number>`sum(case when ${schema.agentExecutions.status} = 'success' then 1 else 0 end)`,
        avgLatencyMs: avg(schema.agentExecutions.latencyMs),
        totalTokens: sum(schema.agentExecutions.totalTokens),
      })
      .from(schema.agentExecutions)
      .groupBy(schema.agentExecutions.agentId)
      .all();
    res.json({ agents: rows });
  }));

  router.get("/recent-requests", asyncRoute(async (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 25) || 25, 100);
    const rows = await ctx.db
      .select({
        id: schema.modelRequests.id,
        modelId: schema.modelRequests.modelId,
        status: schema.modelRequests.status,
        totalTokens: schema.modelRequests.totalTokens,
        estimatedCostUsd: schema.modelRequests.estimatedCostUsd,
        latencyMs: schema.modelRequests.latencyMs,
        errorCode: schema.modelRequests.errorCode,
        createdAt: schema.modelRequests.createdAt,
        agentExecutionId: schema.modelRequests.agentExecutionId,
      })
      .from(schema.modelRequests)
      .orderBy(desc(schema.modelRequests.createdAt))
      .limit(limit);
    res.json({ requests: rows });
  }));

  router.get("/recent-errors", asyncRoute(async (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 10) || 10, 100);
    const rows = await ctx.db
      .select()
      .from(schema.modelRequests)
      .where(sql`${schema.modelRequests.status} = 'error'`)
      .orderBy(desc(schema.modelRequests.createdAt))
      .limit(limit);
    res.json({ errors: rows.map((r) => ({ ...r })) });
  }));

  return router;
}
