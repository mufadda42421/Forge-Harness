import { Router } from "express";
import { z } from "zod";
import { eq, desc, and } from "drizzle-orm";
import { schema } from "@forge/database";
import { ForgeError } from "@forge/shared";
import { lexicalScore } from "@forge/core";
import type { AppContext } from "../context.js";
import { asyncRoute, parseBody, parseQuery } from "../http.js";
import { audit } from "../audit.js";

export function contextRoutes(ctx: AppContext): Router {
  const router = Router();

  /* projects */
  router.get("/projects", asyncRoute(async (_req, res) => {
    const projects = await ctx.db.select().from(schema.projects).orderBy(desc(schema.projects.createdAt));
    res.json({ projects });
  }));

  router.post("/projects", asyncRoute(async (req, res) => {
    const body = parseBody(z.object({
      name: z.string().trim().min(1).max(160),
      rootPath: z.string().max(2048).nullable().optional(),
      metadata: z.record(z.unknown()).default({}),
    }), req.body);
    const created = ctx.db.insert(schema.projects).values({
      name: body.name,
      rootPath: body.rootPath ?? null,
      metadataJson: JSON.stringify(body.metadata),
    }).returning().all()[0]!;
    audit(ctx, "project.create", created.name, {});
    res.status(201).json({ project: created });
  }));

  router.delete("/projects/:id", asyncRoute(async (req, res) => {
    ctx.db.delete(schema.projects).where(eq(schema.projects.id, req.params.id!)).run();
    res.json({ ok: true });
  }));

  /* context documents (user-authored; never auto-uploaded anywhere) */
  router.get("/documents", asyncRoute(async (_req, res) => {
    const docs = await ctx.db.select().from(schema.contextDocuments).orderBy(desc(schema.contextDocuments.updatedAt));
    res.json({ documents: docs });
  }));

  router.post("/documents", asyncRoute(async (req, res) => {
    const body = parseBody(z.object({
      scope: z.enum(["global", "project", "agent"]).default("global"),
      projectId: z.string().nullable().optional(),
      agentId: z.string().nullable().optional(),
      title: z.string().trim().min(1).max(256),
      content: z.string().min(1).max(500_000),
      mimeType: z.string().max(128).default("text/markdown"),
      tags: z.array(z.string().max(64)).max(32).optional(),
    }), req.body);
    if (body.scope === "project" && !body.projectId) throw ForgeError.validation("scope=project requires projectId");
    if (body.scope === "agent" && !body.agentId) throw ForgeError.validation("scope=agent requires agentId");
    const created = ctx.db.insert(schema.contextDocuments).values({
      scope: body.scope,
      projectId: body.projectId ?? null,
      agentId: body.agentId ?? null,
      title: body.title,
      content: body.content,
      mimeType: body.mimeType,
      tagsJson: JSON.stringify(body.tags ?? []),
    }).returning().all()[0]!;
    audit(ctx, "context.document_create", created.title, { scope: created.scope });
    res.status(201).json({ document: created });
  }));

  router.patch("/documents/:id", asyncRoute(async (req, res) => {
    const body = parseBody(z.object({
      title: z.string().trim().min(1).max(256).optional(),
      content: z.string().min(1).max(500_000).optional(),
      tags: z.array(z.string().max(64)).max(32).optional(),
    }), req.body);
    const rows = await ctx.db.select().from(schema.contextDocuments).where(eq(schema.contextDocuments.id, req.params.id!));
    if (rows.length === 0) throw ForgeError.notFound("Document");
    const doc = rows[0]!;
    const updated = ctx.db.update(schema.contextDocuments).set({
      title: body.title ?? doc.title,
      content: body.content ?? doc.content,
      tagsJson: body.tags ? JSON.stringify(body.tags) : doc.tagsJson,
      version: doc.version + 1,
      updatedAt: Date.now(),
    }).where(eq(schema.contextDocuments.id, doc.id)).returning().all()[0]!;
    res.json({ document: updated });
  }));

  router.delete("/documents/:id", asyncRoute(async (req, res) => {
    ctx.db.delete(schema.contextDocuments).where(eq(schema.contextDocuments.id, req.params.id!)).run();
    audit(ctx, "context.document_delete", req.params.id!, {});
    res.json({ ok: true });
  }));

  router.get("/documents/search", asyncRoute(async (req, res) => {
    const { q } = parseQuery(z.object({ q: z.string().min(1).max(1000) }), req.query);
    const docs = await ctx.db.select().from(schema.contextDocuments);
    const ranked = docs
      .map((d) => ({ document: d, score: lexicalScore(q, `${d.title}\n${d.content}`) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);
    res.json({ results: ranked });
  }));

  /* memory entries */
  router.get("/memory", asyncRoute(async (_req, res) => {
    const entries = await ctx.db.select().from(schema.memoryEntries).orderBy(desc(schema.memoryEntries.createdAt)).limit(200);
    res.json({ memory: entries });
  }));

  router.post("/memory", asyncRoute(async (req, res) => {
    const body = parseBody(z.object({
      scope: z.enum(["global", "project", "agent"]).default("global"),
      projectId: z.string().nullable().optional(),
      agentId: z.string().nullable().optional(),
      content: z.string().trim().min(1).max(20_000),
      source: z.enum(["manual", "agent"]).default("manual"),
    }), req.body);
    const created = ctx.db.insert(schema.memoryEntries).values({
      scope: body.scope,
      projectId: body.projectId ?? null,
      agentId: body.agentId ?? null,
      content: body.content,
      source: body.source,
    }).returning().all()[0]!;
    res.status(201).json({ entry: created });
  }));

  router.delete("/memory/:id", asyncRoute(async (req, res) => {
    ctx.db.delete(schema.memoryEntries).where(eq(schema.memoryEntries.id, req.params.id!)).run();
    res.json({ ok: true });
  }));

  return router;
}
