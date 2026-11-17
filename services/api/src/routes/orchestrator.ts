import { Router } from "express";
import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { schema } from "@forge/database";
import { ForgeError } from "@forge/shared";
import { runOrchestration } from "@forge/core";
import type { AppContext } from "../context.js";
import { asyncRoute, parseBody } from "../http.js";
import { audit } from "../audit.js";

const runSchema = z.object({
  pattern: z.enum(["sequential", "parallel", "hierarchical", "evaluator", "debate"]),
  input: z.string().min(1).max(200_000),
  steps: z.array(z.object({
    agentId: z.string().min(1),
    task: z.string().max(100_000).optional(),
    role: z.string().max(120).optional(),
  })).min(1).max(16),
  judgeAgentId: z.string().optional(),
  supervisorAgentId: z.string().optional(),
  maxIterations: z.number().int().min(1).max(5).optional(),
  projectId: z.string().nullable().optional(),
  approveTools: z.boolean().default(false),
});

export function orchestratorRoutes(ctx: AppContext): Router {
  const router = Router();

  router.post("/run", asyncRoute(async (req, res) => {
    const body = parseBody(runSchema, req.body);
    const ac = new AbortController();
    res.on("close", () => { if (!res.writableEnded) ac.abort(); });
    const result = await runOrchestration(ctx.db, ctx.router, {
      pattern: body.pattern,
      input: body.input,
      steps: body.steps,
      judgeAgentId: body.judgeAgentId,
      supervisorAgentId: body.supervisorAgentId,
      maxIterations: body.maxIterations,
      projectId: body.projectId ?? null,
      triggeredBy: "orchestrator",
      approveTool: async () => body.approveTools,
      signal: ac.signal,
    });
    audit(ctx, "orchestrator.run", body.pattern, { executionId: result.executionId, steps: body.steps.length, status: result.status });
    res.json(result);
  }));

  router.get("/executions", asyncRoute(async (_req, res) => {
    const rows = await ctx.db.select().from(schema.workflowExecutions)
      .orderBy(desc(schema.workflowExecutions.createdAt))
      .limit(50);
    res.json({ executions: rows });
  }));

  router.get("/executions/:id", asyncRoute(async (req, res) => {
    const rows = await ctx.db.select().from(schema.workflowExecutions).where(eq(schema.workflowExecutions.id, req.params.id!));
    if (rows.length === 0) throw ForgeError.notFound("Execution");
    const messages = await ctx.db.select().from(schema.agentMessages)
      .where(eq(schema.agentMessages.workflowExecutionId, req.params.id!))
      .orderBy(schema.agentMessages.createdAt);
    const agentRuns = await ctx.db.select().from(schema.agentExecutions)
      .where(eq(schema.agentExecutions.workflowExecutionId, req.params.id!))
      .orderBy(schema.agentExecutions.createdAt);
    res.json({ execution: rows[0], messages, agentRuns });
  }));

  return router;
}
