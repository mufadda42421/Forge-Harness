import { spawn } from "node:child_process";
import { and, eq } from "drizzle-orm";
import { schema, type ForgeDatabase } from "@forge/database";
import { ForgeError } from "@forge/shared";
import { assertUrlAllowed, redactSecrets } from "@forge/security";
import { nowMs } from "@forge/shared";

export type ToolPolicyDecision = "allow" | "require_approval" | "deny";

export interface ToolPolicy {
  /** When false, no tool may run without explicit user approval. Default true for read-only tools. */
  autoApproveReadOnly: boolean;
  /** When true, ALL tools run without approval. Dangerous; off by default. */
  autoApproveAll: boolean;
}

export const DEFAULT_TOOL_POLICY: ToolPolicy = {
  autoApproveReadOnly: true,
  autoApproveAll: false,
};

/**
 * Permission boundaries:
 *  - 'dangerous' tools always require approval, even with autoApproveReadOnly.
 *  - tools flagged requiresApproval require it unless policy.autoApproveAll.
 */
export function decideToolPolicy(
  tool: { permission: string; requiresApproval: boolean; enabled: boolean },
  policy: ToolPolicy = DEFAULT_TOOL_POLICY,
): ToolPolicyDecision {
  if (!tool.enabled) return "deny";
  if (policy.autoApproveAll) return "allow";
  if (tool.permission === "dangerous") return "require_approval";
  if (tool.requiresApproval) return "require_approval";
  if (tool.permission === "read-only" && policy.autoApproveReadOnly) return "allow";
  return "require_approval";
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * Minimal MCP stdio client: initialize → initialized → tools/call.
 * The server process is killed after the call completes or on timeout.
 */
async function callMcpStdioServer(
  command: string,
  args: string[],
  env: Record<string, string> | undefined,
  toolName: string,
  toolArgs: unknown,
  timeoutMs: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let buffer = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        reject(new ForgeError("PROVIDER_TIMEOUT", `MCP server timed out after ${timeoutMs}ms`, 504));
      }
    }, timeoutMs);
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      child.kill("SIGKILL");
    };
    const send = (msg: unknown) => {
      child.stdin.write(JSON.stringify(msg) + "\n");
    };
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let msg: JsonRpcResponse;
        try {
          msg = JSON.parse(trimmed) as JsonRpcResponse;
        } catch {
          continue;
        }
        if (msg.id === 1) {
          // initialize result → send initialized notification, then the call
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: toolName, arguments: toolArgs } });
        } else if (msg.id === 2) {
          if (msg.error) {
            finish(() => reject(ForgeError.provider(`MCP error ${msg.error!.code}: ${msg.error!.message}`, 502)));
          } else {
            finish(() => resolve(msg.result));
          }
          return;
        }
      }
    });
    child.on("error", (err) => {
      finish(() => reject(ForgeError.providerUnreachable(`Failed to spawn MCP server "${command}": ${err.message}`)));
    });
    child.on("exit", (code) => {
      if (!settled) {
        finish(() => reject(ForgeError.providerUnreachable(`MCP server exited early (code ${String(code)})`)));
      }
    });
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "forge-harness", version: "0.1.0" },
      },
    });
  });
}

export interface ToolExecutionResult {
  status: "success" | "error" | "denied" | "awaiting_approval";
  output?: unknown;
  error?: string;
  durationMs: number;
}

/**
 * Execute a registered tool with policy enforcement and an audit log entry.
 * `approved` must be true for executions that passed an explicit user approval
 * checkpoint (or were auto-approved by policy).
 */
export async function executeTool(
  db: ForgeDatabase,
  toolIntegrationId: string,
  args: unknown,
  opts: { approved?: boolean; agentExecutionId?: string; policy?: ToolPolicy } = {},
): Promise<ToolExecutionResult> {
  const started = nowMs();
  const rows = await db
    .select()
    .from(schema.toolIntegrations)
    .where(eq(schema.toolIntegrations.id, toolIntegrationId))
    .limit(1);
  const tool = rows[0];
  if (!tool) throw ForgeError.notFound("Tool integration");

  const policy = opts.policy ?? DEFAULT_TOOL_POLICY;
  const decision = decideToolPolicy(tool, policy);
  const logBase = {
    toolIntegrationId: tool.id,
    agentExecutionId: opts.agentExecutionId ?? null,
    inputJson: JSON.stringify(redactSecrets(JSON.stringify(args ?? {}))).slice(0, 10_000),
  };

  if (decision === "deny") {
    db.insert(schema.toolExecutionLogs).values({ ...logBase, status: "denied", approvedBy: null }).run();
    return { status: "denied", error: "Tool is disabled", durationMs: nowMs() - started };
  }
  if (decision === "require_approval" && !opts.approved) {
    db.insert(schema.toolExecutionLogs).values({ ...logBase, status: "awaiting_approval", approvedBy: null }).run();
    return { status: "awaiting_approval", durationMs: nowMs() - started };
  }
  const approvedBy = opts.approved ? "user" : "policy";

  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(tool.configJson) as Record<string, unknown>;
  } catch {
    config = {};
  }

  try {
    let output: unknown;
    if (tool.type === "http") {
      output = await runHttpTool(config, args, tool.timeoutMs);
    } else if (tool.type === "mcp") {
      const command = String(config["command"] ?? "");
      if (!command) throw ForgeError.validation("MCP tool requires config.command");
      const mcpArgs = Array.isArray(config["args"]) ? (config["args"] as string[]) : [];
      const env = config["env"] && typeof config["env"] === "object" ? (config["env"] as Record<string, string>) : undefined;
      const toolName = String((args as Record<string, unknown>)["tool"] ?? config["toolName"] ?? "");
      if (!toolName) throw ForgeError.validation("MCP tool call requires a tool name (args.tool)");
      output = await callMcpStdioServer(command, mcpArgs, env, toolName, (args as Record<string, unknown>)["arguments"] ?? {}, tool.timeoutMs);
    } else {
      throw ForgeError.validation(`Tool type "${tool.type}" is not executable by the built-in runner yet`);
    }
    const durationMs = nowMs() - started;
    db.insert(schema.toolExecutionLogs).values({
      ...logBase,
      status: "success",
      outputJson: JSON.stringify(output).slice(0, 10_000),
      durationMs,
      approvedBy,
    }).run();
    return { status: "success", output, durationMs };
  } catch (err) {
    const durationMs = nowMs() - started;
    const message = redactSecrets(err instanceof Error ? err.message : String(err));
    db.insert(schema.toolExecutionLogs).values({ ...logBase, status: "error", error: message.slice(0, 500), durationMs, approvedBy }).run();
    return { status: "error", error: message, durationMs };
  }
}

/** Built-in http_request tool: fixed or argument-provided URL, SSRF-guarded. */
async function runHttpTool(
  config: Record<string, unknown>,
  args: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const a = (args ?? {}) as Record<string, unknown>;
  const url = String(a["url"] ?? config["url"] ?? "");
  if (!url) throw ForgeError.validation("http tool requires a url (args.url or config.url)");
  const method = String(a["method"] ?? config["method"] ?? "GET").toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(method)) {
    throw ForgeError.validation(`Unsupported method: ${method}`);
  }
  assertUrlAllowed(url, { allowPrivateNetwork: true });
  const headers = {
    ...(typeof config["headers"] === "object" ? (config["headers"] as Record<string, string>) : {}),
    ...(typeof a["headers"] === "object" ? (a["headers"] as Record<string, string>) : {}),
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: a["body"] !== undefined ? String(a["body"]) : undefined,
      signal: controller.signal,
      redirect: "follow",
    });
    const text = await res.text();
    return { status: res.status, ok: res.ok, body: text.slice(0, 8_000), truncated: text.length > 8_000 };
  } finally {
    clearTimeout(timer);
  }
}
