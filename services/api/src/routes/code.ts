import { Router } from "express";
import { z } from "zod";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { eq, desc } from "drizzle-orm";
import { schema } from "@forge/database";
import { ForgeError } from "@forge/shared";
import type { AppContext } from "../context.js";
import { asyncRoute, parseBody, parseQuery } from "../http.js";
import { audit } from "../audit.js";

/**
 * Code panel API: project registry + a strictly sandboxed file explorer.
 *
 * Safety model:
 *  - Every file operation is resolved against the project's rootPath and must
 *    stay inside it (realpath prefix check — no traversal).
 *  - Secret-looking paths are always refused: .env*, *.pem/*.key/*.p12/*.pfx,
 *    id_rsa, credentials*, *secret*, .npmrc, .netrc, .kdbx, .ssh/.
 *  - node_modules, .git, dist, build, coverage are skipped in trees.
 *  - Reads capped at 1.5 MB; binary files (NUL bytes) refused.
 */

const DENY_SEGMENTS = new Set([".git", "node_modules", ".ssh", ".aws", ".gnupg"]);
const DENY_FILE_RE = new RegExp(
  [
    // .env (and .env.local etc.) — but .env.example/.sample/.template are fine to read
    String.raw`(^|[\\/])\.env($|[._-](?!example$|sample$|template$))`,
    String.raw`\.(pem|key|p12|pfx|kdbx)$`,
    String.raw`(^|[\\/])id_rsa`,
    String.raw`(^|[\\/])credentials`,
    String.raw`secret`,
    String.raw`\.netrc$`,
    String.raw`\.npmrc$`,
  ].join("|"),
  "i",
);
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", "out", ".turbo", ".cache"]);
const MAX_FILE_BYTES = 1_500_000;
const MAX_TREE_ENTRIES = 4000;

function assertInsideRoot(root: string, candidate: string): string {
  const resolved = path.resolve(root, candidate);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw ForgeError.validation("Path escapes the project root");
  }
  if (DENY_SEGMENTS.has(path.basename(resolved).toLowerCase())) {
    throw ForgeError.validation("This directory is not explorable");
  }
  return resolved;
}

function assertAllowedFilePath(root: string, candidate: string): string {
  const resolved = assertInsideRoot(root, candidate);
  const rel = path.relative(root, resolved);
  if (DENY_FILE_RE.test(rel)) {
    throw ForgeError.validation("Refusing to touch a secret-looking path");
  }
  return resolved;
}

async function projectRoot(ctx: AppContext, id: string): Promise<string> {
  const rows = await ctx.db.select().from(schema.projects).where(eq(schema.projects.id, id)).limit(1);
  const project = rows[0];
  if (!project) throw ForgeError.notFound("Project");
  if (!project.rootPath) {
    throw ForgeError.validation(`Project "${project.name}" has no root path. Edit the project to set one.`);
  }
  const root = await fsp.realpath(project.rootPath);
  const stat = await fsp.stat(root).catch(() => null);
  if (!stat?.isDirectory()) {
    throw ForgeError.validation(`Project root "${project.rootPath}" is not a directory`);
  }
  return root;
}

async function buildTree(root: string) {
  const entries: Array<{ path: string; type: "file" | "dir"; size: number; mtimeMs: number }> = [];
  const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
    if (entries.length >= MAX_TREE_ENTRIES) return;
    if (depth > 8) return;
    let dirents: fs.Dirent[];
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    dirents.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
    for (const dirent of dirents) {
      if (entries.length >= MAX_TREE_ENTRIES) return;
      if (dirent.name.startsWith(".") && dirent.isDirectory() && SKIP_DIRS.has(dirent.name)) continue;
      if (dirent.isDirectory() && SKIP_DIRS.has(dirent.name)) continue;
      const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name;
      const abs = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        entries.push({ path: rel, type: "dir", size: 0, mtimeMs: 0 });
        await walk(abs, rel, depth + 1);
      } else if (dirent.isFile()) {
        if (DENY_FILE_RE.test(rel)) continue; // never list secret-looking files
        const stat = await fsp.stat(abs).catch(() => null);
        entries.push({ path: rel, type: "file", size: stat?.size ?? 0, mtimeMs: stat?.mtimeMs ?? 0 });
      }
    }
  };
  await walk(root, "", 0);
  return entries;
}

export function codeRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get("/projects", asyncRoute(async (_req, res) => {
    const projects = await ctx.db.select().from(schema.projects).orderBy(desc(schema.projects.createdAt));
    res.json({ projects });
  }));

  router.post("/projects", asyncRoute(async (req, res) => {
    const body = parseBody(z.object({
      name: z.string().trim().min(1).max(160),
      rootPath: z.string().trim().min(1).max(2048).nullable().optional(),
    }), req.body);
    if (body.rootPath) {
      const root = await fsp.realpath(body.rootPath).catch(() => null);
      if (!root) throw ForgeError.validation(`Root path does not exist: ${body.rootPath}`);
      const stat = await fsp.stat(root).catch(() => null);
      if (!stat?.isDirectory()) throw ForgeError.validation("Root path must be a directory");
    }
    const created = ctx.db.insert(schema.projects).values({
      name: body.name,
      rootPath: body.rootPath ?? null,
      metadataJson: "{}",
    }).returning().all()[0]!;
    audit(ctx, "project.create", created.name, { via: "code" });
    res.status(201).json({ project: created });
  }));

  router.patch("/projects/:id", asyncRoute(async (req, res) => {
    const body = parseBody(z.object({
      name: z.string().trim().min(1).max(160).optional(),
      rootPath: z.string().trim().min(1).max(2048).nullable().optional(),
    }), req.body);
    const rows = await ctx.db.select().from(schema.projects).where(eq(schema.projects.id, req.params.id!));
    if (rows.length === 0) throw ForgeError.notFound("Project");
    if (body.rootPath) {
      const root = await fsp.realpath(body.rootPath).catch(() => null);
      if (!root) throw ForgeError.validation(`Root path does not exist: ${body.rootPath}`);
    }
    const updated = ctx.db.update(schema.projects)
      .set({ name: body.name ?? rows[0]!.name, rootPath: body.rootPath === undefined ? rows[0]!.rootPath : body.rootPath, updatedAt: Date.now() })
      .where(eq(schema.projects.id, req.params.id!))
      .returning().all()[0]!;
    res.json({ project: updated });
  }));

  router.delete("/projects/:id", asyncRoute(async (req, res) => {
    ctx.db.delete(schema.projects).where(eq(schema.projects.id, req.params.id!)).run();
    audit(ctx, "project.delete", req.params.id!, { via: "code" });
    res.json({ ok: true });
  }));

  router.get("/projects/:id/tree", asyncRoute(async (req, res) => {
    const root = await projectRoot(ctx, req.params.id!);
    const entries = await buildTree(root);
    res.json({ root, entries, truncated: entries.length >= MAX_TREE_ENTRIES });
  }));

  router.get("/projects/:id/file", asyncRoute(async (req, res) => {
    const { path: rel } = parseQuery(z.object({ path: z.string().min(1).max(2048) }), req.query);
    const root = await projectRoot(ctx, req.params.id!);
    const abs = assertAllowedFilePath(root, rel);
    const stat = await fsp.stat(abs).catch(() => null);
    if (!stat?.isFile()) throw ForgeError.notFound("File");
    if (stat.size > MAX_FILE_BYTES) throw ForgeError.validation(`File too large (${Math.round(stat.size / 1024)} KB > 1.5 MB)`);
    const buf = await fsp.readFile(abs);
    if (buf.includes(0)) throw ForgeError.validation("Binary file — refusing to display");
    res.json({ path: rel, size: stat.size, content: buf.toString("utf8") });
  }));

  router.put("/projects/:id/file", asyncRoute(async (req, res) => {
    const body = parseBody(z.object({
      path: z.string().min(1).max(2048),
      content: z.string().max(2_000_000),
    }), req.body);
    const root = await projectRoot(ctx, req.params.id!);
    const abs = assertAllowedFilePath(root, body.path);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, body.content, "utf8");
    audit(ctx, "code.file_write", body.path, { projectId: req.params.id!, bytes: Buffer.byteLength(body.content) });
    res.json({ ok: true, bytes: Buffer.byteLength(body.content) });
  }));

  return router;
}
