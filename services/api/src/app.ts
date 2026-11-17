import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { errorMiddleware, requestLogger } from "./http.js";
import { CredentialCipher } from "@forge/security";
import type { AppContext } from "./context.js";
import { providersRoutes } from "./routes/providers.js";
import { modelsRoutes } from "./routes/models.js";
import { inferenceRoutes } from "./routes/inference.js";
import { agentsRoutes } from "./routes/agents.js";
import { orchestratorRoutes } from "./routes/orchestrator.js";
import { workflowsRoutes } from "./routes/workflows.js";
import { arenaRoutes } from "./routes/arena.js";
import { benchmarksRoutes } from "./routes/benchmarks.js";
import { contextRoutes } from "./routes/context.js";
import { toolsRoutes } from "./routes/tools.js";
import { opencodeRoutes } from "./routes/opencode.js";
import { analyticsRoutes } from "./routes/analytics.js";
import { settingsRoutes } from "./routes/settings.js";
import { overviewRoutes } from "./routes/overview.js";
import { codeRoutes } from "./routes/code.js";

export interface BuildAppOptions {
  apiToken?: string | null;
  /** Extra allowed dev origins, e.g. http://127.0.0.1:5173 for the Vite dev server. */
  allowedOrigins?: string[];
}

function resolveDashboardDist(): string {
  if (process.env.FORGE_DASHBOARD_DIST) return process.env.FORGE_DASHBOARD_DIST;
  const candidates: string[] = [];
  // eslint-disable-next-line no-undef
  if (typeof __dirname !== "undefined") {
    candidates.push(path.resolve(__dirname, "../dashboard-dist"));
    candidates.push(path.resolve(__dirname, "dashboard-dist"));
  }
  candidates.push(path.resolve(process.cwd(), "dashboard-dist"));
  try {
    candidates.push(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../apps/dashboard/dist"));
  } catch {
    /* import.meta unavailable in bundled CJS */
  }
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "index.html"))) return candidate;
  }
  return candidates[0] ?? path.resolve("dashboard-dist");
}

export function buildApp(ctx: AppContext, options: BuildAppOptions = {}): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use(requestLogger);
  app.use(express.json({ limit: "2mb" }));

  // Loopback + same-origin by default. CORS only for the explicitly allowed
  // dev origins (Vite). Everything else is same-origin (no CORS headers).
  const allowed = new Set(options.allowedOrigins ?? ["http://127.0.0.1:5173", "http://localhost:5173"]);
  app.use(cors({
    origin(origin, callback) {
      if (!origin || allowed.has(origin)) return callback(null, true);
      return callback(null, false);
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["content-type", "authorization"],
    maxAge: 600,
  }));

  // Optional bearer token for the API. When unset, the server refuses to bind
  // to non-loopback hosts (see index.ts); loopback access is always possible.
  if (options.apiToken) {
    const expected = options.apiToken;
    app.use("/api", (req: Request, res: Response, next: NextFunction) => {
      const header = req.header("authorization") ?? "";
      const token = header.startsWith("Bearer ") ? header.slice(7) : "";
      if (!token || !CredentialCipher.safeEqual(token, expected)) {
        res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Missing or invalid API token" } });
        return;
      }
      next();
    });
  }

  const api = express.Router();
  api.get("/health", (_req, res) => res.json({ ok: true }));
  api.use("/overview", overviewRoutes(ctx));
  api.use("/providers", providersRoutes(ctx));
  api.use("/models", modelsRoutes(ctx));
  api.use("/router", inferenceRoutes(ctx));
  api.use("/agents", agentsRoutes(ctx));
  api.use("/orchestrator", orchestratorRoutes(ctx));
  api.use("/workflows", workflowsRoutes(ctx));
  api.use("/arena", arenaRoutes(ctx));
  api.use("/benchmarks", benchmarksRoutes(ctx));
  api.use("/context", contextRoutes(ctx));
  api.use("/code", codeRoutes(ctx));
  api.use("/tools", toolsRoutes(ctx));
  api.use("/opencode", opencodeRoutes(ctx));
  api.use("/analytics", analyticsRoutes(ctx));
  api.use("/settings", settingsRoutes(ctx));
  app.use("/api/v1", api);

  // Static dashboard (production): FORGE_DASHBOARD_DIST wins; otherwise look
  // next to the bundle, then cwd, then the dev-layout relative path.
  const dashboardDist = resolveDashboardDist();
  if (fs.existsSync(path.join(dashboardDist, "index.html"))) {
    app.use(express.static(dashboardDist, {
      maxAge: "1h",
      index: "index.html",
      setHeaders(res, filePath) {
        // HTML entry must always revalidate — it references hashed assets.
        if (filePath.endsWith(".html")) {
          res.setHeader("Cache-Control", "no-cache, must-revalidate");
        }
      },
    }));
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.sendFile(path.join(dashboardDist, "index.html"));
    });
  }

  app.use((_req, res) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found" } });
  });
  app.use(errorMiddleware);

  return app;
}
