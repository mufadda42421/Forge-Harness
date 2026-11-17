import { Router } from "express";
import { z } from "zod";
import { eq, desc, max } from "drizzle-orm";
import { schema } from "@forge/database";
import { ForgeError } from "@forge/shared";
import { runWorkflow, validateWorkflowDefinition, type WorkflowDefinition } from "@forge/core";
import type { AppContext } from "../context.js";
import { asyncRoute, parseBody } from "../http.js";
import { audit } from "../audit.js";

const nodeSchema = z.object({
  key: z.string().min(1).max(80),
  type: z.enum(["input", "agent", "model", "tool", "condition", "approval", "output"]),
  label: z.string().max(120).default(""),
  config: z.record(z.unknown()).default({}),
  position: z.object({ x: z.number(), y: z.number() }).optional(),
});
const edgeSchema = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
  condition: z.enum(["true", "false"]).nullable().optional(),
});
const definitionSchema = z.object({
  nodes: z.array(nodeSchema).min(1).max(100),
  edges: z.array(edgeSchema).max(300),
});

export function workflowsRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get("/", asyncRoute(async (_req, res) => {
    const rows = await ctx.db.select().from(schema.workflows).orderBy(desc(schema.workflows.updatedAt));
    const versions = await ctx.db.select({ workflowId: schema.workflowVersions.workflowId, v: max(schema.workflowVersions.version) })
      .from(schema.workflowVersions)
      .groupBy(schema.workflowVersions.workflowId);
    const latest = new Map(versions.map((v) => [v.workflowId, v.v ?? 0]));
    res.json({ workflows: rows.map((w) => ({ ...w, latestVersion: latest.get(w.id) ?? 0 })) });
  }));

  router.post("/", asyncRoute(async (req, res) => {
    const body = parseBody(z.object({
      name: z.string().trim().min(1).max(160),
      description: z.string().max(2000).default(""),
      tags: z.array(z.string().max(64)).max(32).optional(),
    }), req.body);
    const created = ctx.db.insert(schema.workflows).values({
      name: body.name,
      description: body.description,
      tagsJson: JSON.stringify(body.tags ?? []),
      enabled: true,
    }).returning().all()[0]!;
    audit(ctx, "workflow.create", created.name, {});
    res.status(201).json({ workflow: created });
  }));

  router.get("/:id", asyncRoute(async (req, res) => {
    const rows = await ctx.db.select().from(schema.workflows).where(eq(schema.workflows.id, req.params.id!));
    if (rows.length === 0) throw ForgeError.notFound("Workflow");
    const versionRows = await ctx.db.select().from(schema.workflowVersions)
      .where(eq(schema.workflowVersions.workflowId, req.params.id!))
      .orderBy(desc(schema.workflowVersions.version))
      .limit(1);
    const latestVersion = versionRows[0] ?? null;
    let definition: WorkflowDefinition | null = null;
    if (latestVersion) definition = JSON.parse(latestVersion.definitionJson) as WorkflowDefinition;
    res.json({ workflow: rows[0], latestVersion: latestVersion ? { id: latestVersion.id, version: latestVersion.version } : null, definition });
  }));

  router.patch("/:id", asyncRoute(async (req, res) => {
    const body = parseBody(z.object({
      name: z.string().trim().min(1).max(160).optional(),
      description: z.string().max(2000).optional(),
      enabled: z.boolean().optional(),
      tags: z.array(z.string().max(64)).max(32).optional(),
    }), req.body);
    const rows = await ctx.db.select().from(schema.workflows).where(eq(schema.workflows.id, req.params.id!));
    if (rows.length === 0) throw ForgeError.notFound("Workflow");
    const updates: Record<string, unknown> = { updatedAt: Date.now() };
    if (body.name !== undefined) updates.name = body.name;
    if (body.description !== undefined) updates.description = body.description;
    if (body.enabled !== undefined) updates.enabled = body.enabled;
    if (body.tags !== undefined) updates.tagsJson = JSON.stringify(body.tags);
    const updated = ctx.db.update(schema.workflows).set(updates).where(eq(schema.workflows.id, req.params.id!)).returning().all()[0]!;
    audit(ctx, "workflow.update", updated.name, { fields: Object.keys(updates) });
    res.json({ workflow: updated });
  }));

  router.delete("/:id", asyncRoute(async (req, res) => {
    const rows = await ctx.db.select().from(schema.workflows).where(eq(schema.workflows.id, req.params.id!));
    if (rows.length === 0) throw ForgeError.notFound("Workflow");
    ctx.db.delete(schema.workflows).where(eq(schema.workflows.id, req.params.id!)).run();
    audit(ctx, "workflow.delete", rows[0]!.name, {});
    res.json({ ok: true });
  }));

  router.post("/:id/validate", asyncRoute(async (req, res) => {
    const definition = parseBody(definitionSchema, req.body);
    const result = validateWorkflowDefinition(definition as WorkflowDefinition);
    res.json(result);
  }));

  router.post("/:id/versions", asyncRoute(async (req, res) => {
    const definition = parseBody(definitionSchema, req.body) as WorkflowDefinition;
    const validation = validateWorkflowDefinition(definition);
    if (!validation.valid) {
      throw ForgeError.validation("Workflow definition is invalid", validation.errors);
    }
    const wf = await ctx.db.select().from(schema.workflows).where(eq(schema.workflows.id, req.params.id!));
    if (wf.length === 0) throw ForgeError.notFound("Workflow");

    const current = await ctx.db.select({ v: max(schema.workflowVersions.version) })
      .from(schema.workflowVersions)
      .where(eq(schema.workflowVersions.workflowId, req.params.id!));
    const nextVersion = (current[0]?.v ?? 0) + 1;

    const versionId = crypto.randomUUID();
    ctx.db.transaction((tx) => {
      tx.insert(schema.workflowVersions).values({
        id: versionId,
        workflowId: req.params.id!,
        version: nextVersion,
        definitionJson: JSON.stringify(definition),
      }).run();
      for (const node of definition.nodes) {
        tx.insert(schema.workflowNodes).values({
          workflowVersionId: versionId,
          nodeKey: node.key,
          type: node.type,
          label: node.label,
          configJson: JSON.stringify(node.config ?? {}),
          positionX: node.position?.x ?? 0,
          positionY: node.position?.y ?? 0,
        }).run();
      }
      for (const edge of definition.edges) {
        tx.insert(schema.workflowEdges).values({
          workflowVersionId: versionId,
          sourceNodeKey: edge.source,
          targetNodeKey: edge.target,
          condition: edge.condition ?? null,
        }).run();
      }
      tx.update(schema.workflows).set({ updatedAt: Date.now() }).where(eq(schema.workflows.id, req.params.id!)).run();
    });
    audit(ctx, "workflow.version_save", req.params.id!, { version: nextVersion, nodes: definition.nodes.length, edges: definition.edges.length });
    res.status(201).json({ version: nextVersion, warnings: validation.warnings });
  }));

  router.post("/:id/run", asyncRoute(async (req, res) => {
    const body = parseBody(z.object({
      input: z.unknown(),
      approveTools: z.boolean().default(false),
      projectId: z.string().nullable().optional(),
      approvedNodes: z.array(z.string()).optional(),
    }), req.body ?? {});
    const wf = await ctx.db.select().from(schema.workflows).where(eq(schema.workflows.id, req.params.id!));
    if (wf.length === 0) throw ForgeError.notFound("Workflow");
    const versionRows = await ctx.db.select().from(schema.workflowVersions)
      .where(eq(schema.workflowVersions.workflowId, req.params.id!))
      .orderBy(desc(schema.workflowVersions.version))
      .limit(1);
    if (versionRows.length === 0) {
      throw ForgeError.validation("This workflow has no saved version. Save a version first.");
    }
    const version = versionRows[0]!;
    const definition = JSON.parse(version.definitionJson) as WorkflowDefinition;

    const execution = ctx.db.insert(schema.workflowExecutions).values({
      workflowId: req.params.id!,
      workflowVersionId: version.id,
      status: "running",
      inputJson: JSON.stringify(body.input ?? {}),
      triggeredBy: "manual",
      startedAt: Date.now(),
    }).returning({ id: schema.workflowExecutions.id }).all()[0]!;

    const ac = new AbortController();
    res.on("close", () => { if (!res.writableEnded) ac.abort(); });
    const result = await runWorkflow(ctx.db, ctx.router, {
      executionId: execution.id,
      definition,
      input: body.input,
      projectId: body.projectId ?? null,
      approvedNodes: new Set(body.approvedNodes ?? []),
      approveTool: async () => body.approveTools,
      signal: ac.signal,
    });

    ctx.db.update(schema.workflowExecutions).set({
      status: result.status,
      outputJson: JSON.stringify(result.status === "awaiting_approval" ? { awaitingNodeKey: result.awaitingNodeKey } : result.output ?? null),
      error: result.error ?? null,
      finishedAt: result.status === "awaiting_approval" ? null : Date.now(),
    }).where(eq(schema.workflowExecutions.id, execution.id)).run();

    audit(ctx, "workflow.run", req.params.id!, { executionId: execution.id, status: result.status });
    res.json({ executionId: execution.id, ...result });
  }));

  // Resume an execution paused at an approval node.
  router.post("/executions/:id/approve", asyncRoute(async (req, res) => {
    const rows = await ctx.db.select().from(schema.workflowExecutions).where(eq(schema.workflowExecutions.id, req.params.id!));
    if (rows.length === 0) throw ForgeError.notFound("Execution");
    const execution = rows[0]!;
    if (execution.status !== "awaiting_approval") {
      throw ForgeError.validation(`Execution is not awaiting approval (status: ${execution.status})`);
    }
    const pauseInfo = execution.outputJson ? JSON.parse(execution.outputJson) as { awaitingNodeKey?: string } : {};
    const nodeKey = pauseInfo.awaitingNodeKey;
    if (!nodeKey) throw ForgeError.internal("Awaiting-approval execution is missing the pending node key");
    if (!execution.workflowVersionId) throw ForgeError.internal("Execution has no workflow version to resume");

    const versionRows = await ctx.db.select().from(schema.workflowVersions).where(eq(schema.workflowVersions.id, execution.workflowVersionId));
    if (versionRows.length === 0) throw ForgeError.notFound("Workflow version");
    const definition = JSON.parse(versionRows[0]!.definitionJson) as WorkflowDefinition;
    const workflowId = rows[0]!.workflowId;
    const originalInput = execution.inputJson ? JSON.parse(execution.inputJson) : {};

    ctx.db.update(schema.workflowExecutions).set({ status: "running", outputJson: null }).where(eq(schema.workflowExecutions.id, execution.id)).run();

    const ac = new AbortController();
    res.on("close", () => { if (!res.writableEnded) ac.abort(); });
    const result = await runWorkflow(ctx.db, ctx.router, {
      executionId: execution.id,
      definition,
      input: originalInput.input !== undefined ? originalInput.input : originalInput,
      approvedNodes: new Set([nodeKey]),
      signal: ac.signal,
    });

    ctx.db.update(schema.workflowExecutions).set({
      status: result.status,
      outputJson: JSON.stringify(result.status === "awaiting_approval" ? { awaitingNodeKey: result.awaitingNodeKey } : result.output ?? null),
      error: result.error ?? null,
      finishedAt: result.status === "awaiting_approval" ? null : Date.now(),
    }).where(eq(schema.workflowExecutions.id, execution.id)).run();

    audit(ctx, "workflow.approve", execution.id, { nodeKey, status: result.status });
    res.json({ executionId: execution.id, resumedNode: nodeKey, ...result });
  }));

  router.get("/executions/:id", asyncRoute(async (req, res) => {
    const rows = await ctx.db.select().from(schema.workflowExecutions).where(eq(schema.workflowExecutions.id, req.params.id!));
    if (rows.length === 0) throw ForgeError.notFound("Execution");
    const messages = await ctx.db.select().from(schema.agentMessages)
      .where(eq(schema.agentMessages.workflowExecutionId, req.params.id!))
      .orderBy(schema.agentMessages.createdAt);
    res.json({ execution: rows[0], messages });
  }));

  router.get("/:id/executions", asyncRoute(async (req, res) => {
    const rows = await ctx.db.select().from(schema.workflowExecutions)
      .where(eq(schema.workflowExecutions.workflowId, req.params.id!))
      .orderBy(desc(schema.workflowExecutions.createdAt))
      .limit(50);
    res.json({ executions: rows });
  }));

  return router;
}
