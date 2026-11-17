import { Router } from "express";
import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { schema } from "@forge/database";
import { ForgeError } from "@forge/shared";
import { runAgent } from "@forge/core";
import type { AppContext } from "../context.js";
import { asyncRoute, parseBody } from "../http.js";
import { audit } from "../audit.js";

const agentSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).default(""),
  systemInstructions: z.string().max(100_000).default(""),
  modelId: z.string().nullable().optional(),
  temperature: z.number().min(0).max(2).default(0.7),
  maxTokens: z.number().int().min(1).max(200_000).default(2048),
  executionLimit: z.number().int().min(1).max(50).default(10),
  retryLimit: z.number().int().min(0).max(10).default(2),
  memoryMode: z.enum(["none", "session", "persistent"]).default("session"),
  contextMode: z.string().max(64).default("manual"),
  outputFormat: z.enum(["text", "json"]).default("text"),
  enabled: z.boolean().default(true),
  isExample: z.boolean().default(false),
});

const EXAMPLE_AGENTS = [
  { name: "Planner Agent", description: "Decomposes tasks into ordered implementation plans.", systemInstructions: "You are a meticulous planning agent. Break the user's task into clear, numbered, dependency-aware steps. Identify risks and unknowns explicitly. Do not implement anything." },
  { name: "Research Agent", description: "Gathers and synthesizes information.", systemInstructions: "You are a research agent. Gather relevant facts for the task, cite your sources of information, distinguish verified facts from assumptions, and present concise findings." },
  { name: "Coding Agent", description: "Implements tasks as code changes.", systemInstructions: "You are a senior software engineer. Implement the requested change with minimal, correct, well-structured code. Prefer small modules and strong types. Explain what you changed." },
  { name: "Review Agent", description: "Reviews generated code for defects.", systemInstructions: "You are a rigorous code reviewer. Find bugs, security issues, and design problems. Rate severity. Approve only when the output is production-ready." },
  { name: "Testing Agent", description: "Writes and verifies tests.", systemInstructions: "You are a testing agent. Write focused unit and integration tests covering happy paths, edge cases and failure modes. Verify the implementation matches expectations." },
  { name: "Documentation Agent", description: "Writes clear technical documentation.", systemInstructions: "You are a documentation agent. Write accurate, concise documentation: what it is, how to install, how to configure, how to use, and known limitations." },
];

export function agentsRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get("/", asyncRoute(async (_req, res) => {
    const rows = await ctx.db.select().from(schema.agents).orderBy(desc(schema.agents.createdAt));
    res.json({ agents: rows });
  }));

  router.post("/", asyncRoute(async (req, res) => {
    const body = parseBody(agentSchema, req.body);
    if (body.modelId) {
      const model = (await ctx.db.select({ id: schema.models.id }).from(schema.models).where(eq(schema.models.id, body.modelId)).limit(1))[0];
      if (!model) throw ForgeError.notFound("Model");
    }
    const created = ctx.db.insert(schema.agents).values({ ...body, modelId: body.modelId ?? null }).returning().all()[0]!;
    audit(ctx, "agent.create", created.name, { isExample: created.isExample });
    res.status(201).json({ agent: created });
  }));

  // Clearly-labeled example agents. Explicit user action; never auto-created.
  router.post("/examples", asyncRoute(async (_req, res) => {
    const created = [];
    for (const example of EXAMPLE_AGENTS) {
      const row = ctx.db.insert(schema.agents).values({
        ...example,
        isExample: true,
        enabled: true,
        modelId: null, // no model assigned — cannot run until the user assigns one
      }).returning().all()[0]!;
      created.push(row);
    }
    audit(ctx, "agent.create_examples", "bulk", { count: created.length });
    res.status(201).json({ agents: created });
  }));

  router.get("/:id", asyncRoute(async (req, res) => {
    const rows = await ctx.db.select().from(schema.agents).where(eq(schema.agents.id, req.params.id!));
    if (rows.length === 0) throw ForgeError.notFound("Agent");
    const tools = await ctx.db.select().from(schema.agentTools).where(eq(schema.agentTools.agentId, req.params.id!));
    res.json({ agent: rows[0], toolGrants: tools });
  }));

  router.patch("/:id", asyncRoute(async (req, res) => {
    const body = parseBody(agentSchema.partial(), req.body);
    const rows = await ctx.db.select().from(schema.agents).where(eq(schema.agents.id, req.params.id!));
    if (rows.length === 0) throw ForgeError.notFound("Agent");
    if (body.modelId) {
      const model = (await ctx.db.select({ id: schema.models.id }).from(schema.models).where(eq(schema.models.id, body.modelId)).limit(1))[0];
      if (!model) throw ForgeError.notFound("Model");
    }
    const updated = ctx.db.update(schema.agents)
      .set({ ...body, updatedAt: Date.now() })
      .where(eq(schema.agents.id, req.params.id!))
      .returning().all()[0]!;
    audit(ctx, "agent.update", updated.name, { fields: Object.keys(body) });
    res.json({ agent: updated });
  }));

  router.delete("/:id", asyncRoute(async (req, res) => {
    const rows = await ctx.db.select().from(schema.agents).where(eq(schema.agents.id, req.params.id!));
    if (rows.length === 0) throw ForgeError.notFound("Agent");
    ctx.db.delete(schema.agents).where(eq(schema.agents.id, req.params.id!)).run();
    audit(ctx, "agent.delete", rows[0]!.name, {});
    res.json({ ok: true });
  }));

  // Tool grants: explicit allowlist — agents never get tools automatically.
  router.put("/:id/tools", asyncRoute(async (req, res) => {
    const body = parseBody(z.object({
      grants: z.array(z.object({
        toolIntegrationId: z.string().min(1),
        permission: z.enum(["read", "write", "execute", "admin"]).default("read"),
        requiresApproval: z.boolean().default(true),
      })).max(64),
    }), req.body);
    const rows = await ctx.db.select({ id: schema.agents.id }).from(schema.agents).where(eq(schema.agents.id, req.params.id!));
    if (rows.length === 0) throw ForgeError.notFound("Agent");
    ctx.db.transaction((tx) => {
      tx.delete(schema.agentTools).where(eq(schema.agentTools.agentId, req.params.id!)).run();
      for (const grant of body.grants) {
        tx.insert(schema.agentTools).values({
          agentId: req.params.id!,
          toolIntegrationId: grant.toolIntegrationId,
          permission: grant.permission,
          requiresApproval: grant.requiresApproval,
        }).run();
      }
    });
    audit(ctx, "agent.tools_update", req.params.id!, { count: body.grants.length });
    res.json({ ok: true, grants: body.grants });
  }));

  router.post("/:id/run", asyncRoute(async (req, res) => {
    const body = parseBody(z.object({
      input: z.string().min(1).max(200_000),
      projectId: z.string().nullable().optional(),
      /** When true, tool calls that require approval are approved for this run. Explicit user opt-in. */
      approveTools: z.boolean().default(false),
    }), req.body);
    const ac = new AbortController();
    res.on("close", () => { if (!res.writableEnded) ac.abort(); });
    const result = await runAgent(ctx.db, ctx.router, {
      agentId: req.params.id!,
      input: body.input,
      projectId: body.projectId ?? null,
      approveTool: async () => body.approveTools,
      signal: ac.signal,
    });
    res.json({
      executionId: result.executionId,
      output: result.output,
      toolCalls: result.toolCalls,
      usage: result.usage,
      latencyMs: result.latencyMs,
      toolMessages: result.toolMessages,
    });
  }));

  router.get("/:id/executions", asyncRoute(async (req, res) => {
    const rows = await ctx.db.select().from(schema.agentExecutions)
      .where(eq(schema.agentExecutions.agentId, req.params.id!))
      .orderBy(desc(schema.agentExecutions.createdAt))
      .limit(50);
    res.json({ executions: rows });
  }));

  return router;
}
