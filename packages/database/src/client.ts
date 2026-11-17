import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";

export * as schema from "./schema.js";
export type ForgeDatabase = BetterSQLite3Database<typeof schema>;

export interface OpenDatabaseOptions {
  /** Absolute path to the SQLite file. Directories are created as needed. */
  databasePath: string;
  /** Directory containing drizzle migration folders. Defaults to <pkg>/drizzle. */
  migrationsFolder?: string;
}

/**
 * Locate the drizzle migrations folder across layouts:
 *  1. <pkg>/dist/../drizzle            (unbundled ESM from packages/database)
 *  2. <dir of the running file>/drizzle (bundled single-file at app/bundle.cjs)
 *  3. <cwd>/drizzle                    (fallback)
 * Returns the first candidate that exists, else candidate 1.
 */
function resolveMigrationsFolder(): string {
  const candidates: string[] = [];
  try {
    candidates.push(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../drizzle"));
  } catch {
    /* import.meta unavailable (bundled CJS) */
  }
  // eslint-disable-next-line no-undef
  if (typeof __dirname !== "undefined") {
    candidates.push(path.resolve(__dirname, "drizzle"));
  }
  candidates.push(path.resolve(process.cwd(), "drizzle"));
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0] ?? path.resolve("drizzle");
}

export function openDatabase(options: OpenDatabaseOptions): { db: ForgeDatabase; sqlite: Database.Database } {
  fs.mkdirSync(path.dirname(options.databasePath), { recursive: true });
  const sqlite = new Database(options.databasePath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  const db = drizzle(sqlite, { schema });
  const migrationsFolder = options.migrationsFolder ?? resolveMigrationsFolder();
  if (fs.existsSync(migrationsFolder)) {
    migrate(db, { migrationsFolder });
  }
  return { db, sqlite };
}
