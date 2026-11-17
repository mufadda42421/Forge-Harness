import { Router } from "express";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { schema } from "@forge/database";
import { ForgeError, ALL_MODEL_CAPABILITIES } from "@forge/shared";
import { assertUrlAllowed, CredentialCipher, redactSecrets } from "@forge/security";
import { createAdapter, type ProviderConfig } from "@forge/core";
import type { AppContext } from "../context.js";
import { asyncRoute, parseBody } from "../http.js";
import { audit } from "../audit.js";

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  identifier: z.string().trim().min(1).max(80).regex(/^[a-z0-9][a-z0-9-_]*$/, "identifier: lowercase letters, digits, dash, underscore"),
  baseUrl: z.string().trim().min(8).max(2048),
  compatibility: z.enum(["openai", "anthropic", "google", "ollama", "openrouter", "custom-http"]),
  authMethod: z.enum(["bearer", "x-api-key", "x-goog-api-key", "none", "custom"]).default("bearer"),
  apiKey: z.string().max(4096).optional(),
  customHeaders: z.record(z.string().max(2048)).optional(),
  timeoutMs: z.number().int().min(1000).max(600_000).default(60_000),
  maxRetries: z.number().int().min(0).max(5).default(2),
  enabled: z.boolean().default(true),
});

const patchSchema = createSchema.partial().omit({ apiKey: true });

function providerView(
  db: AppContext["db"],
  row: typeof schema.providers.$inferSelect,
) {
  const metadata = db
    .select()
    .from(schema.providerCredentialsMetadata)
    .where(eq(schema.providerCredentialsMetadata.providerId, row.id))
    .all()[0];
  const customHeaders = safeJsonObject(row.customHeadersJson);
  return {
    id: row.id,
    name: row.name,
    identifier: row.identifier,
    baseUrl: row.baseUrl,
    compatibility: row.compatibility,
    authMethod: row.authMethod,
    // Header values may contain secrets — never return them.
    customHeaders: Object.fromEntries(Object.keys(customHeaders).map((k) => [k, "[REDACTED]"])),
    timeoutMs: row.timeoutMs,
    maxRetries: row.maxRetries,
    enabled: row.enabled,
    connectionStatus: row.connectionStatus,
    lastTestedAt: row.lastTestedAt,
    lastError: row.lastError,
    hasCredential: Boolean(metadata),
    keyHint: metadata?.keyHint ?? null,
    credentialRotatedAt: metadata?.rotatedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function safeJsonObject(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function decryptFor(ctx: AppContext, providerId: string): string | null {
  if (!ctx.cipher) return null;
  const rows = ctx.db
    .select()
    .from(schema.credentialSecrets)
    .where(and(eq(schema.credentialSecrets.refType, "provider"), eq(schema.credentialSecrets.refId, providerId)))
    .all();
  const secret = rows[0];
  if (!secret) return null;
  return ctx.cipher.decrypt({
    ciphertext: secret.ciphertext,
    iv: secret.iv,
    authTag: secret.authTag,
    algorithm: "aes-256-gcm",
  });
}

function storeCredential(ctx: AppContext, providerId: string, apiKey: string, authMethod: string): void {
  if (!ctx.cipher) {
    throw new ForgeError("CREDENTIAL_ERROR", "Credential store is unavailable (master key not initialized). Set FORGE_MASTER_KEY.", 500);
  }
  const enc = ctx.cipher.encrypt(apiKey);
  ctx.db.transaction((tx) => {
    tx.insert(schema.credentialSecrets)
      .values({ refType: "provider", refId: providerId, ciphertext: enc.ciphertext, iv: enc.iv, authTag: enc.authTag })
      .onConflictDoUpdate({
        target: [schema.credentialSecrets.refType, schema.credentialSecrets.refId],
        set: { ciphertext: enc.ciphertext, iv: enc.iv, authTag: enc.authTag, rotatedAt: Date.now() },
      })
      .run();
    tx.insert(schema.providerCredentialsMetadata)
      .values({ providerId, authMethod, keyHint: CredentialCipher.hint(apiKey), rotatedAt: Date.now() })
      .onConflictDoUpdate({
        target: schema.providerCredentialsMetadata.providerId,
        set: { authMethod, keyHint: CredentialCipher.hint(apiKey), rotatedAt: Date.now() },
      })
      .run();
  });
}

function loadAdapter(ctx: AppContext, row: typeof schema.providers.$inferSelect) {
  const apiKey = decryptFor(ctx, row.id);
  if (row.authMethod !== "none" && !apiKey) {
    throw new ForgeError("CREDENTIAL_ERROR", `No API key configured for provider "${row.name}". Add one before testing or using it.`, 422);
  }
  const customHeaders = safeJsonObject(row.customHeadersJson) as Record<string, string>;
  return createAdapter({
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    compatibility: row.compatibility as ProviderConfig["compatibility"],
    authMethod: row.authMethod as ProviderConfig["authMethod"],
    apiKey,
    customHeaders,
    timeoutMs: row.timeoutMs,
    maxRetries: 0, // connection tests and discovery don't retry
  });
}

export function providersRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get("/", asyncRoute(async (_req, res) => {
    const rows = ctx.db.select().from(schema.providers).all();
    res.json({ providers: rows.map((r) => providerView(ctx.db, r)) });
  }));

  router.post("/", asyncRoute(async (req, res) => {
    const body = parseBody(createSchema, req.body);
    assertUrlAllowed(body.baseUrl, { allowPrivateNetwork: true });
    const existing = ctx.db.select({ id: schema.providers.id }).from(schema.providers)
      .where(eq(schema.providers.identifier, body.identifier)).all();
    if (existing.length > 0) throw ForgeError.conflict(`A provider with identifier "${body.identifier}" already exists`);

    const created = ctx.db.insert(schema.providers).values({
      name: body.name,
      identifier: body.identifier,
      baseUrl: body.baseUrl,
      compatibility: body.compatibility,
      authMethod: body.authMethod,
      customHeadersJson: JSON.stringify(body.customHeaders ?? {}),
      timeoutMs: body.timeoutMs,
      maxRetries: body.maxRetries,
      enabled: body.enabled,
    }).returning().all()[0]!;

    if (body.apiKey) {
      storeCredential(ctx, created.id, body.apiKey, body.authMethod);
    }
    audit(ctx, "provider.create", created.identifier, { compatibility: body.compatibility, authMethod: body.authMethod, hasApiKey: Boolean(body.apiKey) });
    res.status(201).json({ provider: providerView(ctx.db, created) });
  }));

  router.get("/:id", asyncRoute(async (req, res) => {
    const rows = ctx.db.select().from(schema.providers).where(eq(schema.providers.id, req.params.id!)).all();
    if (rows.length === 0) throw ForgeError.notFound("Provider");
    res.json({ provider: providerView(ctx.db, rows[0]!) });
  }));

  router.patch("/:id", asyncRoute(async (req, res) => {
    const body = parseBody(patchSchema, req.body);
    const rows = ctx.db.select().from(schema.providers).where(eq(schema.providers.id, req.params.id!)).all();
    if (rows.length === 0) throw ForgeError.notFound("Provider");
    const row = rows[0]!;
    if (body.baseUrl) assertUrlAllowed(body.baseUrl, { allowPrivateNetwork: true });
    if (body.identifier && body.identifier !== row.identifier) {
      const clash = ctx.db.select({ id: schema.providers.id }).from(schema.providers)
        .where(eq(schema.providers.identifier, body.identifier)).all();
      if (clash.length > 0) throw ForgeError.conflict(`Identifier "${body.identifier}" is already in use`);
    }
    const updates: Record<string, unknown> = { updatedAt: Date.now() };
    for (const key of ["name", "identifier", "baseUrl", "compatibility", "authMethod", "timeoutMs", "maxRetries", "enabled"] as const) {
      if (body[key] !== undefined) updates[key] = body[key];
    }
    if (body.customHeaders !== undefined) updates["customHeadersJson"] = JSON.stringify(body.customHeaders);
    const updated = ctx.db.update(schema.providers).set(updates).where(eq(schema.providers.id, row.id)).returning().all()[0]!;
    audit(ctx, "provider.update", updated.identifier, { fields: Object.keys(updates) });
    res.json({ provider: providerView(ctx.db, updated) });
  }));

  router.delete("/:id", asyncRoute(async (req, res) => {
    const rows = ctx.db.select().from(schema.providers).where(eq(schema.providers.id, req.params.id!)).all();
    if (rows.length === 0) throw ForgeError.notFound("Provider");
    const row = rows[0]!;
    ctx.db.transaction((tx) => {
      tx.delete(schema.credentialSecrets).where(and(eq(schema.credentialSecrets.refType, "provider"), eq(schema.credentialSecrets.refId, row.id))).run();
      tx.delete(schema.providerCredentialsMetadata).where(eq(schema.providerCredentialsMetadata.providerId, row.id)).run();
      tx.delete(schema.providers).where(eq(schema.providers.id, row.id)).run();
    });
    audit(ctx, "provider.delete", row.identifier, {});
    res.json({ ok: true });
  }));

  router.post("/:id/apikey", asyncRoute(async (req, res) => {
    const body = parseBody(z.object({ apiKey: z.string().trim().min(8).max(4096) }), req.body);
    const rows = ctx.db.select().from(schema.providers).where(eq(schema.providers.id, req.params.id!)).all();
    if (rows.length === 0) throw ForgeError.notFound("Provider");
    const row = rows[0]!;
    storeCredential(ctx, row.id, body.apiKey, row.authMethod);
    audit(ctx, "provider.credential_rotate", row.identifier, {});
    res.json({ ok: true, keyHint: CredentialCipher.hint(body.apiKey) });
  }));

  router.delete("/:id/apikey", asyncRoute(async (req, res) => {
    const rows = ctx.db.select().from(schema.providers).where(eq(schema.providers.id, req.params.id!)).all();
    if (rows.length === 0) throw ForgeError.notFound("Provider");
    const row = rows[0]!;
    ctx.db.transaction((tx) => {
      tx.delete(schema.credentialSecrets).where(and(eq(schema.credentialSecrets.refType, "provider"), eq(schema.credentialSecrets.refId, row.id))).run();
      tx.delete(schema.providerCredentialsMetadata).where(eq(schema.providerCredentialsMetadata.providerId, row.id)).run();
    });
    audit(ctx, "provider.credential_delete", row.identifier, {});
    res.json({ ok: true });
  }));

  router.post("/:id/test", asyncRoute(async (req, res) => {
    const rows = ctx.db.select().from(schema.providers).where(eq(schema.providers.id, req.params.id!)).all();
    if (rows.length === 0) throw ForgeError.notFound("Provider");
    const row = rows[0]!;
    try {
      const adapter = loadAdapter(ctx, row);
      const result = await adapter.testConnection();
      ctx.db.update(schema.providers)
        .set({ connectionStatus: "ok", lastTestedAt: Date.now(), lastError: null, updatedAt: Date.now() })
        .where(eq(schema.providers.id, row.id))
        .run();
      audit(ctx, "provider.test", row.identifier, { ok: true, latencyMs: result.latencyMs }, "system");
      res.json({ ok: true, latencyMs: result.latencyMs, detail: result.detail, discoveredModels: result.discoveredModels });
    } catch (err) {
      const message = redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 500);
      ctx.db.update(schema.providers)
        .set({ connectionStatus: "error", lastTestedAt: Date.now(), lastError: message, updatedAt: Date.now() })
        .where(eq(schema.providers.id, row.id))
        .run();
      audit(ctx, "provider.test", row.identifier, { ok: false, error: message }, "system");
      res.status(502).json({ ok: false, error: { code: "PROVIDER_UNREACHABLE", message } });
    }
  }));

  router.post("/:id/discover", asyncRoute(async (req, res) => {
    const rows = ctx.db.select().from(schema.providers).where(eq(schema.providers.id, req.params.id!)).all();
    if (rows.length === 0) throw ForgeError.notFound("Provider");
    const row = rows[0]!;
    const adapter = loadAdapter(ctx, row);
    const discovered = await adapter.discoverModels();
    res.json({ models: discovered });
  }));

  router.post("/:id/discover/import", asyncRoute(async (req, res) => {
    const body = parseBody(z.object({ modelIds: z.array(z.string().min(1)).optional() }), req.body ?? {});
    const rows = ctx.db.select().from(schema.providers).where(eq(schema.providers.id, req.params.id!)).all();
    if (rows.length === 0) throw ForgeError.notFound("Provider");
    const row = rows[0]!;
    const adapter = loadAdapter(ctx, row);
    const discovered = await adapter.discoverModels();
    const selected = body.modelIds?.length
      ? discovered.filter((m) => body.modelIds!.includes(m.modelId))
      : discovered;
    const created: string[] = [];
    const existing = new Set(
      ctx.db.select({ modelId: schema.models.modelId }).from(schema.models)
        .where(eq(schema.models.providerId, row.id)).all().map((m) => m.modelId),
    );
    ctx.db.transaction((tx) => {
      for (const m of selected) {
        if (existing.has(m.modelId)) continue;
        const rowId = crypto.randomUUID();
        tx.insert(schema.models).values({
          id: rowId,
          providerId: row.id,
          modelId: m.modelId,
          displayName: m.displayName ?? m.modelId,
          contextWindow: m.contextWindow ?? null,
          source: "discovered",
          enabled: true,
        }).run();
        for (const capability of ALL_MODEL_CAPABILITIES) {
          tx.insert(schema.modelCapabilities).values({ modelId: rowId, capability, support: "unknown" }).run();
        }
        created.push(m.modelId);
      }
    });
    audit(ctx, "provider.discover_import", row.identifier, { imported: created.length });
    res.json({ imported: created, skipped: selected.length - created.length });
  }));

  return router;
}
