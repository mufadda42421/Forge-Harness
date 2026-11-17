import { Router } from "express";
import { z } from "zod";
import { eq, desc, and } from "drizzle-orm";
import { schema } from "@forge/database";
import { ForgeError } from "@forge/shared";
import { assertUrlAllowed, CredentialCipher } from "@forge/security";
import { OpenCodeClient } from "@forge/core";
import type { AppContext } from "../context.js";
import { asyncRoute, parseBody } from "../http.js";
import { audit } from "../audit.js";

const connSchema = z.object({
  name: z.string().trim().min(1).max(120),
  baseUrl: z.string().trim().min(8).max(2048),
  enabled: z.boolean().default(true),
  username: z.string().max(256).optional(),
  password: z.string().max(4096).optional(),
});

function connectionView(conn: typeof schema.opencodeConnections.$inferSelect, hasCredential: boolean) {
  return {
    id: conn.id,
    name: conn.name,
    baseUrl: conn.baseUrl,
    enabled: conn.enabled,
    connectionStatus: conn.connectionStatus,
    lastTestedAt: conn.lastTestedAt,
    lastError: conn.lastError,
    hasCredential,
    createdAt: conn.createdAt,
    updatedAt: conn.updatedAt,
  };
}

async function loadClient(ctx: AppContext, connId: string): Promise<OpenCodeClient> {
  const rows = await ctx.db.select().from(schema.opencodeConnections).where(eq(schema.opencodeConnections.id, connId));
  const conn = rows[0];
  if (!conn) throw ForgeError.notFound("OpenCode connection");
  let username: string | null = null;
  let password: string | null = null;
  if (ctx.cipher) {
    const secretRows = ctx.db.select().from(schema.credentialSecrets)
      .where(and(eq(schema.credentialSecrets.refType, "opencode"), eq(schema.credentialSecrets.refId, connId)))
      .all();
    const secret = secretRows[0];
    if (secret) {
      try {
        password = ctx.cipher.decrypt({ ciphertext: secret.ciphertext, iv: secret.iv, authTag: secret.authTag, algorithm: "aes-256-gcm" });
        username = "opencode"; // stored separately? keep simple: username fixed when password exists, overridable via env
      } catch {
        password = null;
      }
    }
  }
  return new OpenCodeClient({ baseUrl: conn.baseUrl, username, password });
}

export function opencodeRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get("/connections", asyncRoute(async (_req, res) => {
    const rows = await ctx.db.select().from(schema.opencodeConnections).orderBy(desc(schema.opencodeConnections.createdAt));
    const withCreds = new Set(
      ctx.db.select({ refId: schema.credentialSecrets.refId }).from(schema.credentialSecrets)
        .where(eq(schema.credentialSecrets.refType, "opencode")).all().map((r) => r.refId),
    );
    res.json({ connections: rows.map((r) => connectionView(r, withCreds.has(r.id))) });
  }));

  router.post("/connections", asyncRoute(async (req, res) => {
    const body = parseBody(connSchema, req.body);
    assertUrlAllowed(body.baseUrl, { allowPrivateNetwork: true });
    const created = ctx.db.insert(schema.opencodeConnections).values({
      name: body.name,
      baseUrl: body.baseUrl,
      enabled: body.enabled,
    }).returning().all()[0]!;
    if (body.password && ctx.cipher) {
      const enc = ctx.cipher.encrypt(body.password);
      ctx.db.insert(schema.credentialSecrets).values({
        refType: "opencode",
        refId: created.id,
        ciphertext: enc.ciphertext,
        iv: enc.iv,
        authTag: enc.authTag,
      }).run();
    }
    audit(ctx, "opencode.connection_create", created.name, { baseUrl: body.baseUrl });
    res.status(201).json({ connection: connectionView(created, Boolean(body.password)) });
  }));

  router.patch("/connections/:id", asyncRoute(async (req, res) => {
    const body = parseBody(connSchema.partial(), req.body);
    const rows = await ctx.db.select().from(schema.opencodeConnections).where(eq(schema.opencodeConnections.id, req.params.id!));
    if (rows.length === 0) throw ForgeError.notFound("OpenCode connection");
    const row = rows[0]!;
    if (body.baseUrl) assertUrlAllowed(body.baseUrl, { allowPrivateNetwork: true });
    const updates: Record<string, unknown> = { updatedAt: Date.now() };
    if (body.name !== undefined) updates.name = body.name;
    if (body.baseUrl !== undefined) updates.baseUrl = body.baseUrl;
    if (body.enabled !== undefined) updates.enabled = body.enabled;
    const updated = ctx.db.update(schema.opencodeConnections).set(updates).where(eq(schema.opencodeConnections.id, row.id)).returning().all()[0]!;
    if (body.password && ctx.cipher) {
      const enc = ctx.cipher.encrypt(body.password);
      ctx.db.insert(schema.credentialSecrets).values({
        refType: "opencode",
        refId: updated.id,
        ciphertext: enc.ciphertext,
        iv: enc.iv,
        authTag: enc.authTag,
      }).onConflictDoUpdate({
        target: [schema.credentialSecrets.refType, schema.credentialSecrets.refId],
        set: { ciphertext: enc.ciphertext, iv: enc.iv, authTag: enc.authTag, rotatedAt: Date.now() },
      }).run();
    }
    audit(ctx, "opencode.connection_update", updated.name, { fields: Object.keys(updates) });
    res.json({ connection: connectionView(updated, true) });
  }));

  router.delete("/connections/:id", asyncRoute(async (req, res) => {
    const rows = await ctx.db.select().from(schema.opencodeConnections).where(eq(schema.opencodeConnections.id, req.params.id!));
    if (rows.length === 0) throw ForgeError.notFound("OpenCode connection");
    ctx.db.transaction((tx) => {
      tx.delete(schema.credentialSecrets)
        .where(and(eq(schema.credentialSecrets.refType, "opencode"), eq(schema.credentialSecrets.refId, req.params.id!)))
        .run();
      tx.delete(schema.opencodeConnections).where(eq(schema.opencodeConnections.id, req.params.id!)).run();
    });
    audit(ctx, "opencode.connection_delete", rows[0]!.name, {});
    res.json({ ok: true });
  }));

  router.post("/connections/:id/test", asyncRoute(async (req, res) => {
    const rows = await ctx.db.select().from(schema.opencodeConnections).where(eq(schema.opencodeConnections.id, req.params.id!));
    if (rows.length === 0) throw ForgeError.notFound("OpenCode connection");
    const row = rows[0]!;
    try {
      const client = await loadClient(ctx, row.id);
      const result = await client.testConnection();
      ctx.db.update(schema.opencodeConnections).set({ connectionStatus: "ok", lastTestedAt: Date.now(), lastError: null, updatedAt: Date.now() })
        .where(eq(schema.opencodeConnections.id, row.id)).run();
      audit(ctx, "opencode.test", row.name, { ok: true }, "system");
      res.json({ ok: true, latencyMs: result.latencyMs, detail: result.detail });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.db.update(schema.opencodeConnections).set({ connectionStatus: "error", lastTestedAt: Date.now(), lastError: message.slice(0, 500), updatedAt: Date.now() })
        .where(eq(schema.opencodeConnections.id, row.id)).run();
      res.status(502).json({ ok: false, error: { code: "PROVIDER_UNREACHABLE", message } });
    }
  }));

  router.get("/connections/:id/sessions", asyncRoute(async (req, res) => {
    const client = await loadClient(ctx, req.params.id!);
    const sessions = await client.listSessions();
    res.json({ sessions });
  }));

  router.post("/connections/:id/sessions", asyncRoute(async (req, res) => {
    const body = parseBody(z.object({ title: z.string().max(200).optional() }), req.body ?? {});
    const client = await loadClient(ctx, req.params.id!);
    const session = await client.createSession(body.title);
    audit(ctx, "opencode.session_create", req.params.id!, { sessionId: session.id });
    res.status(201).json({ session });
  }));

  router.post("/connections/:id/sessions/:sessionId/prompt", asyncRoute(async (req, res) => {
    const body = parseBody(z.object({ text: z.string().min(1).max(100_000) }), req.body);
    const client = await loadClient(ctx, req.params.id!);
    const result = await client.sendPrompt(req.params.sessionId!, body.text);
    audit(ctx, "opencode.session_prompt", req.params.id!, { sessionId: req.params.sessionId });
    res.json({ result });
  }));

  router.post("/connections/:id/sessions/:sessionId/abort", asyncRoute(async (req, res) => {
    const client = await loadClient(ctx, req.params.id!);
    await client.abortSession(req.params.sessionId!);
    audit(ctx, "opencode.session_abort", req.params.id!, { sessionId: req.params.sessionId });
    res.json({ ok: true });
  }));

  router.get("/connections/:id/sessions/:sessionId/messages", asyncRoute(async (req, res) => {
    const client = await loadClient(ctx, req.params.id!);
    const messages = await client.getSessionMessages(req.params.sessionId!);
    res.json({ messages });
  }));

  return router;
}
