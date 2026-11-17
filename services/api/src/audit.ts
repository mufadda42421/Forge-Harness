import { schema } from "@forge/database";
import type { AppContext } from "./context.js";
import { redactValue } from "@forge/security";

/** Append an audit log entry. Details are redacted before persistence. */
export function audit(
  ctx: AppContext,
  action: string,
  target: string,
  details: Record<string, unknown> = {},
  actor: "user" | "system" = "user",
): void {
  try {
    ctx.db.insert(schema.auditLogs).values({
      actor,
      action,
      target,
      detailsJson: JSON.stringify(redactValue(details)),
    }).run();
  } catch (err) {
    console.error("[forge] audit log failed:", err instanceof Error ? err.message : err);
  }
}
