import { Router } from "express";
import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { schema } from "@forge/database";
import { ForgeError, ALL_MODEL_CAPABILITIES } from "@forge/shared";
import type { AppContext } from "../context.js";
import { asyncRoute, parseBody } from "../http.js";
import { audit } from "../audit.js";

const modelCreateSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().trim().min(1).max(256),
  displayName: z.string().trim().min(1).max(256).optional(),
  contextWindow: z.number().int().positive().nullable().optional(),
  maxOutputTokens: z.number().int().positive().nullable().optional(),
  inputCostPer1M: z.number().nonnegative().nullable().optional(),
  outputCostPer1M: z.number().nonnegative().nullable().optional(),
  supportsStreaming: z.boolean().nullable().optional(),
  supportsTools: z.boolean().nullable().optional(),
  supportsVision: z.boolean().nullable().optional(),
  tags: z.array(z.string().max(64)).max(32).optional(),
  enabled: z.boolean().default(true),
  capabilities: z.record(z.enum(["supported", "unsupported", "unknown"])).optional(),
});

const modelPatchSchema = modelCreateSchema.partial().omit({ providerId: true });

async function modelView(db: AppContext["db"], row: typeof schema.models.$inferSelect) {
  const provider = (await db.select().from(schema.providers).where(eq(schema.providers.id, row.providerId)).limit(1))[0];
  const caps = await db.select().from(schema.modelCapabilities).where(eq(schema.modelCapabilities.modelId, row.id));
  const capabilities = Object.fromEntries(caps.map((c) => [c.capability, c.support]));
  return {
    id: row.id,
    providerId: row.providerId,
    providerName: provider?.name ?? "(deleted provider)",
    providerIdentifier: provider?.identifier ?? null,
    modelId: row.modelId,
    displayName: row.displayName,
    contextWindow: row.contextWindow,
    maxOutputTokens: row.maxOutputTokens,
    inputCostPer1M: row.inputCostPer1M,
    outputCostPer1M: row.outputCostPer1M,
    costConfigured: row.costConfigured,
    supportsStreaming: row.supportsStreaming,
    supportsTools: row.supportsTools,
    supportsVision: row.supportsVision,
    tags: safeJsonArray(row.tagsJson),
    enabled: row.enabled,
    source: row.source,
    capabilities,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function safeJsonArray(text: string): string[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

async function syncCapabilities(
  db: AppContext["db"],
  modelRowId: string,
  capabilities: Record<string, string>,
): Promise<void> {
  for (const capability of ALL_MODEL_CAPABILITIES) {
    const support = capabilities[capability] ?? "unknown";
    db.insert(schema.modelCapabilities)
      .values({ modelId: modelRowId, capability, support })
      .onConflictDoUpdate({
        target: [schema.modelCapabilities.modelId, schema.modelCapabilities.capability],
        set: { support },
      })
      .run();
  }
}

export function modelsRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get("/", asyncRoute(async (req, res) => {
    const search = typeof req.query.search === "string" ? req.query.search.toLowerCase() : "";
    const providerId = typeof req.query.providerId === "string" ? req.query.providerId : undefined;
    let rows = await ctx.db.select().from(schema.models).orderBy(desc(schema.models.createdAt));
    if (providerId) rows = rows.filter((r) => r.providerId === providerId);
    if (search) rows = rows.filter((r) => `${r.displayName} ${r.modelId}`.toLowerCase().includes(search));
    const views = [];
    for (const row of rows) views.push(await modelView(ctx.db, row));
    res.json({ models: views });
  }));

  router.post("/", asyncRoute(async (req, res) => {
    const body = parseBody(modelCreateSchema, req.body);
    const provider = (await ctx.db.select().from(schema.providers).where(eq(schema.providers.id, body.providerId)).limit(1))[0];
    if (!provider) throw ForgeError.notFound("Provider");
    const costConfigured = body.inputCostPer1M != null && body.outputCostPer1M != null;
    const created = ctx.db.insert(schema.models).values({
      providerId: body.providerId,
      modelId: body.modelId,
      displayName: body.displayName ?? body.modelId,
      contextWindow: body.contextWindow ?? null,
      maxOutputTokens: body.maxOutputTokens ?? null,
      inputCostPer1M: body.inputCostPer1M ?? null,
      outputCostPer1M: body.outputCostPer1M ?? null,
      costConfigured,
      supportsStreaming: body.supportsStreaming ?? null,
      supportsTools: body.supportsTools ?? null,
      supportsVision: body.supportsVision ?? null,
      tagsJson: JSON.stringify(body.tags ?? []),
      enabled: body.enabled,
      source: "manual",
    }).returning().all()[0]!;
    await syncCapabilities(ctx.db, created.id, body.capabilities ?? {});
    audit(ctx, "model.register", created.modelId, { provider: provider.identifier, source: "manual" });
    res.status(201).json({ model: await modelView(ctx.db, created) });
  }));

  // Export registered models (metadata only — never credentials)
  router.get("/export", asyncRoute(async (_req, res) => {
    const rows = await ctx.db.select().from(schema.models);
    const views = [];
    for (const row of rows) views.push(await modelView(ctx.db, row));
    res.json({ forge: "models-export", version: 1, models: views });
  }));

  router.post("/import", asyncRoute(async (req, res) => {
    const body = parseBody(z.object({
      models: z.array(z.object({
        providerId: z.string().min(1),
        modelId: z.string().min(1),
        displayName: z.string().optional(),
        contextWindow: z.number().int().positive().nullable().optional(),
        inputCostPer1M: z.number().nonnegative().nullable().optional(),
        outputCostPer1M: z.number().nonnegative().nullable().optional(),
        capabilities: z.record(z.enum(["supported", "unsupported", "unknown"])).optional(),
        tags: z.array(z.string()).optional(),
      })).min(1).max(500),
    }), req.body);
    let imported = 0;
    for (const m of body.models) {
      const provider = (await ctx.db.select().from(schema.providers).where(eq(schema.providers.id, m.providerId)).limit(1))[0];
      if (!provider) continue;
      const costConfigured = m.inputCostPer1M != null && m.outputCostPer1M != null;
      try {
        const created = ctx.db.insert(schema.models).values({
          providerId: m.providerId,
          modelId: m.modelId,
          displayName: m.displayName ?? m.modelId,
          contextWindow: m.contextWindow ?? null,
          inputCostPer1M: m.inputCostPer1M ?? null,
          outputCostPer1M: m.outputCostPer1M ?? null,
          costConfigured,
          tagsJson: JSON.stringify(m.tags ?? []),
          source: "import",
          enabled: true,
        }).returning().all()[0]!;
        await syncCapabilities(ctx.db, created.id, m.capabilities ?? {});
        imported += 1;
      } catch {
        /* duplicate (providerId, modelId) — skip */
      }
    }
    audit(ctx, "model.import", "bulk", { imported });
    res.json({ imported });
  }));

  router.get("/:id", asyncRoute(async (req, res) => {
    const rows = await ctx.db.select().from(schema.models).where(eq(schema.models.id, req.params.id!));
    if (rows.length === 0) throw ForgeError.notFound("Model");
    res.json({ model: await modelView(ctx.db, rows[0]!) });
  }));

  router.patch("/:id", asyncRoute(async (req, res) => {
    const body = parseBody(modelPatchSchema, req.body);
    const rows = await ctx.db.select().from(schema.models).where(eq(schema.models.id, req.params.id!));
    if (rows.length === 0) throw ForgeError.notFound("Model");
    const row = rows[0]!;
    const updates: Record<string, unknown> = { updatedAt: Date.now() };
    for (const key of ["modelId", "displayName", "contextWindow", "maxOutputTokens", "supportsStreaming", "supportsTools", "supportsVision", "enabled"] as const) {
      if (body[key] !== undefined) updates[key] = body[key];
    }
    if (body.inputCostPer1M !== undefined) updates["inputCostPer1M"] = body.inputCostPer1M;
    if (body.outputCostPer1M !== undefined) updates["outputCostPer1M"] = body.outputCostPer1M;
    if (body.inputCostPer1M !== undefined || body.outputCostPer1M !== undefined) {
      updates["costConfigured"] = (body.inputCostPer1M ?? row.inputCostPer1M) != null && (body.outputCostPer1M ?? row.outputCostPer1M) != null;
    }
    if (body.tags !== undefined) updates["tagsJson"] = JSON.stringify(body.tags);
    const updated = ctx.db.update(schema.models).set(updates).where(eq(schema.models.id, row.id)).returning().all()[0]!;
    if (body.capabilities) await syncCapabilities(ctx.db, updated.id, body.capabilities);
    audit(ctx, "model.update", updated.modelId, { fields: Object.keys(updates) });
    res.json({ model: await modelView(ctx.db, updated) });
  }));

  router.delete("/:id", asyncRoute(async (req, res) => {
    const rows = await ctx.db.select().from(schema.models).where(eq(schema.models.id, req.params.id!));
    if (rows.length === 0) throw ForgeError.notFound("Model");
    const row = rows[0]!;
    ctx.db.delete(schema.models).where(eq(schema.models.id, row.id)).run();
    audit(ctx, "model.delete", row.modelId, {});
    res.json({ ok: true });
  }));

  return router;
}
