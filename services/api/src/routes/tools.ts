import { Router } from "express";
import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { schema } from "@forge/database";
import { ForgeError } from "@forge/shared";
import { executeTool } from "@forge/core";
import type { AppContext } from "../context.js";
import { asyncRoute, parseBody } from "../http.js";
import { audit } from "../audit.js";

const toolSchema = z.object({
  name: z.string().trim().min(1).max(80).regex(/^[a-z0-9][a-z0-9-_.]*$/, "tool names: lowercase letters, digits, dash, underscore, dot"),
  type: z.enum(["http", "filesystem", "terminal", "git", "mcp", "custom"]),
  description: z.string().max(2000).default(""),
  inputSchema: z.record(z.unknown()).default({ type: "object", properties: {} }),
  outputSchema: z.record(z.unknown()).default({ type: "object", properties: {} }),
  config: z.record(z.unknown()).default({}),
  permission: z.enum(["read-only", "standard", "dangerous"]).default("read-only"),
  requiresApproval: z.boolean().default(true),
  timeoutMs: z.number().int().min(1000).max(300_000).default(30_000),
  enabled: z.boolean().default(true),
});

export function toolsRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get("/", asyncRoute(async (_req, res) => {
    const rows = await ctx.db.select().from(schema.toolIntegrations).orderBy(desc(schema.toolIntegrations.createdAt));
    res.json({
      tools: rows.map((t) => ({
        ...t,
        // config may contain secrets for custom tools — return redacted config
        config: redactConfig(safeObject(t.configJson)),
      })),
    });
  }));

  router.post("/", asyncRoute(async (req, res) => {
    const body = parseBody(toolSchema, req.body);
    const existing = ctx.db.select({ id: schema.toolIntegrations.id }).from(schema.toolIntegrations).where(eq(schema.toolIntegrations.name, body.name)).all();
    if (existing.length > 0) throw ForgeError.conflict(`Tool "${body.name}" already exists`);
    const created = ctx.db.insert(schema.toolIntegrations).values({
      name: body.name,
      type: body.type,
      description: body.description,
      inputSchemaJson: JSON.stringify(body.inputSchema),
      outputSchemaJson: JSON.stringify(body.outputSchema),
      configJson: JSON.stringify(body.config),
      permission: body.permission,
      requiresApproval: body.requiresApproval,
      timeoutMs: body.timeoutMs,
      enabled: body.enabled,
    }).returning().all()[0]!;
    audit(ctx, "tool.create", created.name, { type: created.type, permission: created.permission });
    res.status(201).json({ tool: { ...created, config: redactConfig(safeObject(created.configJson)) } });
  }));

  router.patch("/:id", asyncRoute(async (req, res) => {
    const body = parseBody(toolSchema.partial(), req.body);
    const rows = await ctx.db.select().from(schema.toolIntegrations).where(eq(schema.toolIntegrations.id, req.params.id!));
    if (rows.length === 0) throw ForgeError.notFound("Tool");
    const updates: Record<string, unknown> = { updatedAt: Date.now() };
    for (const key of ["name", "type", "description", "permission", "requiresApproval", "timeoutMs", "enabled"] as const) {
      if (body[key] !== undefined) updates[key] = body[key];
    }
    if (body.inputSchema !== undefined) updates["inputSchemaJson"] = JSON.stringify(body.inputSchema);
    if (body.outputSchema !== undefined) updates["outputSchemaJson"] = JSON.stringify(body.outputSchema);
    if (body.config !== undefined) updates["configJson"] = JSON.stringify(body.config);
    const updated = ctx.db.update(schema.toolIntegrations).set(updates).where(eq(schema.toolIntegrations.id, req.params.id!)).returning().all()[0]!;
    audit(ctx, "tool.update", updated.name, { fields: Object.keys(updates) });
    res.json({ tool: { ...updated, config: redactConfig(safeObject(updated.configJson)) } });
  }));

  router.delete("/:id", asyncRoute(async (req, res) => {
    const rows = await ctx.db.select().from(schema.toolIntegrations).where(eq(schema.toolIntegrations.id, req.params.id!));
    if (rows.length === 0) throw ForgeError.notFound("Tool");
    ctx.db.delete(schema.toolIntegrations).where(eq(schema.toolIntegrations.id, req.params.id!)).run();
    audit(ctx, "tool.delete", rows[0]!.name, {});
    res.json({ ok: true });
  }));

  /** Execute a tool manually. Dangerous tools require approved=true (explicit user confirmation). */
  router.post("/:id/execute", asyncRoute(async (req, res) => {
    const body = parseBody(z.object({
      args: z.record(z.unknown()).default({}),
      approved: z.boolean().default(false),
    }), req.body ?? {});
    const result = await executeTool(ctx.db, req.params.id!, body.args, { approved: body.approved });
    audit(ctx, "tool.execute", req.params.id!, { status: result.status, approved: body.approved });
    res.json(result);
  }));

  router.get("/logs", asyncRoute(async (_req, res) => {
    const rows = await ctx.db.select().from(schema.toolExecutionLogs).orderBy(desc(schema.toolExecutionLogs.createdAt)).limit(100);
    res.json({ logs: rows });
  }));

  return router;
}

function safeObject(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** Redact likely-secret values inside tool configs before returning to the UI. */
function redactConfig(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    out[k] = /key|secret|token|password|authorization|env/i.test(k) ? "[REDACTED]" : v;
  }
  return out;
}
