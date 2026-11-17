import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { openDatabase } from "@forge/database";
import { CredentialCipher } from "@forge/security";
import { ModelRouter } from "@forge/core";
import { buildApp } from "./app.js";
import type { AppContext } from "./context.js";

const dataDir = process.env.FORGE_DATA_DIR ?? path.join(os.homedir(), ".forge-harness");
fs.mkdirSync(dataDir, { recursive: true });

const databasePath = process.env.FORGE_DATABASE_PATH ?? path.join(dataDir, "forge-harness.db");
const { db } = openDatabase({ databasePath });

let cipher: CredentialCipher | null = null;
try {
  cipher = CredentialCipher.fromEnvOrFile(dataDir);
} catch (err) {
  console.warn("[forge] credential cipher unavailable:", err instanceof Error ? err.message : err);
}

const ctx: AppContext = {
  db,
  cipher,
  router: new ModelRouter(db, cipher),
  dataDir,
  startedAt: Date.now(),
};

const port = Number(process.env.FORGE_PORT ?? 4789);
const host = process.env.FORGE_HOST ?? "127.0.0.1";
const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
const apiToken = process.env.FORGE_API_TOKEN ?? null;

if (!isLoopback && !apiToken) {
  console.error("[forge] Refusing to bind to a non-loopback host without FORGE_API_TOKEN set.");
  console.error("[forge] Set FORGE_API_TOKEN (or keep FORGE_HOST=127.0.0.1).");
  process.exit(1);
}

const app = buildApp(ctx, { apiToken });

const server = app.listen(port, host, () => {
  console.log(`[forge] Forge Harness API listening on http://${host}:${port}`);
  console.log(`[forge] data directory: ${dataDir}`);
  if (!apiToken) {
    console.log("[forge] API token not set (loopback-only access). Set FORGE_API_TOKEN to require authentication.");
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`\n[forge] ${signal} received, shutting down`);
    server.close(() => process.exit(0));
  });
}
