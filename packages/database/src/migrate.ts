import path from "node:path";
import { openDatabase } from "./client.js";

const databasePath =
  process.env.FORGE_DATABASE_PATH ?? path.join(process.env.FORGE_DATA_DIR ?? ".forge", "forge-harness.db");

const { sqlite } = openDatabase({ databasePath });
sqlite.close();
console.log(`[forge] database migrated at ${databasePath}`);
