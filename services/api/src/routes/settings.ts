import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { schema } from "@forge/database";
import { ForgeError } from "@forge/shared";
import type { AppContext } from "../context.js";
import { asyncRoute, parseBody } from "../http.js";
import { audit } from "../audit.js";

/** Settings are non-secret configuration only. Credential-looking keys are rejected. */
export function settingsRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get("/", asyncRoute(async (_req, res) => {
    const rows = await ctx.db.select().from(schema.settings);
    const out: Record<string, unknown> = {};
    for (const row of rows) {
      try {
        out[row.key] = JSON.parse(row.valueJson);
      } catch {
        out[row.key] = row.valueJson;
      }
    }
    res.json({ settings: out });
  }));

  router.put("/", asyncRoute(async (req, res) => {
    const body = parseBody(z.record(z.unknown()), req.body);
    const forbidden = Object.keys(body).filter((k) => /key|secret|token|password|authorization/i.test(k));
    if (forbidden.length > 0) {
      throw ForgeError.validation(
        "Settings must never contain credentials. Use the provider credential endpoints instead.",
        { rejectedKeys: forbidden },
      );
    }
    ctx.db.transaction((tx) => {
      for (const [key, value] of Object.entries(body)) {
        if (key.length > 128) continue;
        tx.insert(schema.settings)
          .values({ key, valueJson: JSON.stringify(value) })
          .onConflictDoUpdate({ target: schema.settings.key, set: { valueJson: JSON.stringify(value), updatedAt: Date.now() } })
          .run();
      }
    });
    audit(ctx, "settings.update", "settings", { keys: Object.keys(body) });
    res.json({ ok: true, keys: Object.keys(body) });
  }));

  router.delete("/:key", asyncRoute(async (req, res) => {
    ctx.db.delete(schema.settings).where(eq(schema.settings.key, req.params.key!)).run();
    audit(ctx, "settings.delete", req.params.key!, {});
    res.json({ ok: true });
  }));

  return router;
}
