import { createOpencodeClient } from "@opencode-ai/sdk";
import { ForgeError } from "@forge/shared";
import { assertUrlAllowed } from "@forge/security";

export interface OpenCodeConfig {
  baseUrl: string;
  /** Optional HTTP basic auth credentials (encrypted at rest by the caller). */
  username?: string | null;
  password?: string | null;
}

export interface OpenCodeSession {
  id: string;
  title: string;
  directory?: string;
  projectId?: string;
  time?: { created?: number; updated?: number };
}

/**
 * Thin adapter over the supported @opencode-ai/sdk. Every method degrades
 * gracefully when the (optional) OpenCode server is unreachable: callers get
 * a normalized ForgeError, never a crash.
 */
export class OpenCodeClient {
  private readonly client;

  constructor(private readonly config: OpenCodeConfig) {
    assertUrlAllowed(config.baseUrl, { allowPrivateNetwork: true });
    const headers: Record<string, string> = {};
    if (config.username && config.password) {
      headers["authorization"] = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`;
    }
    this.client = createOpencodeClient({ baseUrl: config.baseUrl.replace(/\/+$/, ""), headers } as never);
  }

  private static unwrap<T>(value: unknown): T {
    const v = value as { data?: T; error?: unknown } | T;
    if (v && typeof v === "object" && "data" in (v as object)) {
      const inner = (v as { data: T }).data;
      if (inner !== undefined) return inner;
    }
    return v as T;
  }

  async testConnection(): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
    const started = Date.now();
    try {
      const res = await withTimeout((this.client as any).global.health(), this.config ? 5000 : 5000);
      const data = OpenCodeClient.unwrap<{ healthy?: boolean; version?: string }>(res);
      return { ok: true, latencyMs: Date.now() - started, detail: `OpenCode server healthy (version ${data?.version ?? "unknown"})` };
    } catch (err) {
      // Fallback: some OpenCode versions don't expose /global/health; try listing sessions.
      try {
        const res = await withTimeout((this.client as any).session.list(), 5000);
        OpenCodeClient.unwrap(res);
        return { ok: true, latencyMs: Date.now() - started, detail: "OpenCode server responded to session list" };
      } catch {
        throw ForgeError.providerUnreachable(
          `OpenCode server not reachable at ${this.config.baseUrl}. Start it (e.g. \`opencode serve\`) or fix the connection settings. (${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }
  }

  async listSessions(): Promise<OpenCodeSession[]> {
    const res = await (this.client as any).session.list();
    const data = OpenCodeClient.unwrap<Array<Record<string, unknown>>>(res) ?? [];
    return data.map((s) => ({
      id: String(s["id"]),
      title: String(s["title"] ?? "untitled"),
      directory: typeof s["directory"] === "string" ? s["directory"] : undefined,
      projectId: s["projectID"] ? String(s["projectID"]) : undefined,
      time: s["time"] as OpenCodeSession["time"],
    }));
  }

  async createSession(title?: string): Promise<OpenCodeSession> {
    const res = await (this.client as any).session.create({ body: { title: title ?? "Forge Harness session" } });
    const s = OpenCodeClient.unwrap<Record<string, unknown>>(res);
    if (!s) throw ForgeError.provider("OpenCode did not return a session", 502);
    return {
      id: String(s["id"]),
      title: String(s["title"] ?? title ?? ""),
      directory: typeof s["directory"] === "string" ? s["directory"] : undefined,
      projectId: s["projectID"] ? String(s["projectID"]) : undefined,
      time: s["time"] as OpenCodeSession["time"],
    };
  }

  async sendPrompt(sessionId: string, text: string): Promise<unknown> {
    const res = await (this.client as any).session.prompt({
      path: { id: sessionId },
      body: { parts: [{ type: "text", text }] },
    });
    return OpenCodeClient.unwrap(res);
  }

  async abortSession(sessionId: string): Promise<void> {
    try {
      await (this.client as any).session.abort({ path: { id: sessionId } });
    } catch (err) {
      throw ForgeError.provider(`Failed to abort session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`, 502);
    }
  }

  async getSessionMessages(sessionId: string): Promise<unknown[]> {
    const res = await (this.client as any).session.messages({ path: { id: sessionId } });
    const data = OpenCodeClient.unwrap<unknown[]>(res);
    return Array.isArray(data) ? data : [];
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ForgeError("PROVIDER_TIMEOUT", `OpenCode request timed out after ${ms}ms`, 504)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e))); },
    );
  });
}
