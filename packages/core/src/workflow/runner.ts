import { eq } from "drizzle-orm";
import { schema, type ForgeDatabase } from "@forge/database";
import { ForgeError, nowMs } from "@forge/shared";
import type { ChatMessage } from "@forge/shared";
import type { ModelRouter } from "../router/router.js";
import { runAgent } from "../agents/runner.js";
import { executeTool } from "../tools/manager.js";
import { validateWorkflowDefinition, type WorkflowDefinition, type WorkflowNodeDef } from "./validate.js";

export class ApprovalRequired extends ForgeError {
  readonly nodeKey: string;
  constructor(nodeKey: string, message: string) {
    super("APPROVAL_REQUIRED", message, 428);
    this.nodeKey = nodeKey;
  }
}

export interface WorkflowRunParams {
  executionId: string;
  definition: WorkflowDefinition;
  input: unknown;
  projectId?: string | null;
  /** Node keys already approved (set during resume). */
  approvedNodes?: Set<string>;
  signal?: AbortSignal;
  approveTool?: (toolName: string, args: unknown) => Promise<boolean> | boolean;
}

export interface WorkflowRunResult {
  status: "success" | "failed" | "awaiting_approval" | "cancelled";
  output: unknown;
  awaitingNodeKey?: string;
  error?: string;
  outputs: Record<string, unknown>;
}

interface NodeState {
  output: string;
  status: "success" | "failed";
  error?: string;
}

function renderTemplate(template: string, state: { input: unknown; nodes: Record<string, NodeState> }): string {
  const jsonInput = typeof state.input === "string" ? state.input : JSON.stringify(state.input);
  return template
    .replaceAll("{{input}}", jsonInput)
    .replaceAll("{{nodes.", "{{nodes.")
    .replace(/\{\{nodes\.([a-zA-Z0-9_-]+)\.output\}\}/g, (_, key: string) => state.nodes[key]?.output ?? "");
}

function getPath(state: { input: unknown; nodes: Record<string, NodeState> }, path: string): unknown {
  if (path === "input") return state.input;
  const nodeMatch = /^nodes\.([a-zA-Z0-9_-]+)\.output$/.exec(path);
  if (nodeMatch) return state.nodes[nodeMatch[1]!]?.output ?? null;
  const inputPath = /^input\.(.+)$/.exec(path);
  if (inputPath && typeof state.input === "object" && state.input !== null) {
    return inputPath[1]!.split(".").reduce<unknown>((acc, key) =>
      acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined, state.input);
  }
  return null;
}

function evaluateCondition(
  config: Record<string, unknown>,
  state: { input: unknown; nodes: Record<string, NodeState> },
): boolean {
  const field = String(config["field"] ?? "input");
  const operator = String(config["operator"] ?? "truthy");
  const expected = config["value"];
  const actual = getPath(state, field);
  const str = actual === null || actual === undefined ? "" : typeof actual === "object" ? JSON.stringify(actual) : String(actual);
  switch (operator) {
    case "truthy": return Boolean(actual) && str !== "" && str !== "false" && str !== "0";
    case "falsy": return !Boolean(actual) || str === "" || str === "false" || str === "0";
    case "eq": return str === String(expected ?? "");
    case "neq": return str !== String(expected ?? "");
    case "contains": return str.includes(String(expected ?? ""));
    case "not_contains": return !str.includes(String(expected ?? ""));
    case "gt": return Number(str) > Number(expected);
    case "gte": return Number(str) >= Number(expected);
    case "lt": return Number(str) < Number(expected);
    case "lte": return Number(str) <= Number(expected);
    default: return false;
  }
}

function safeJson(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export async function runWorkflow(
  db: ForgeDatabase,
  router: ModelRouter,
  params: WorkflowRunParams,
): Promise<WorkflowRunResult> {
  const validation = validateWorkflowDefinition(params.definition);
  if (!validation.valid) {
    throw ForgeError.validation("Workflow definition is invalid", validation.errors);
  }

  const executionId = params.executionId;
  const recordNode = (node: WorkflowNodeDef, output: string, status: "success" | "failed", meta: Record<string, unknown> = {}) => {
    db.insert(schema.agentMessages).values({
      workflowExecutionId: executionId,
      role: "tool",
      agentName: `workflow:${node.key}`,
      content: output.slice(0, 100_000),
      metaJson: JSON.stringify({ nodeKey: node.key, nodeType: node.type, status, ...meta }),
    }).run();
  };

  // Resume support: rehydrate outputs of already-completed nodes
  const priorMessages = await db.select().from(schema.agentMessages).where(eq(schema.agentMessages.workflowExecutionId, executionId));
  const nodeStates = new Map<string, NodeState>();
  // ... populated from priorMessages below; also kept in sync during execution
  for (const msg of priorMessages) {
    try {
      const meta = JSON.parse(msg.metaJson) as { nodeKey?: string; nodeType?: string; status?: string };
      if (meta.nodeKey && msg.agentName === `workflow:${meta.nodeKey}` && meta.status === "success") {
        if (!nodeStates.has(meta.nodeKey)) {
          nodeStates.set(meta.nodeKey, { output: msg.content, status: "success" });
        }
      }
    } catch {
      /* ignore malformed meta */
    }
  }

  const state: { input: unknown; nodes: Record<string, NodeState> } = {
    input: params.input,
    nodes: {},
  };
  /** Keep state.nodes in sync — templates and condition evaluation read from it. */
  const refreshStateNodes = () => {
    state.nodes = Object.fromEntries(nodeStates);
  };
  refreshStateNodes();

  const nodes = params.definition.nodes;
  const edges = params.definition.edges ?? [];
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const inDegree = new Map<string, number>(nodes.map((n) => [n.key, 0]));
  for (const edge of edges) inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);

  const completed = new Set<string>(nodeStates.keys());
  const outputs: Record<string, unknown> = Object.fromEntries(nodeStates);

  const downstreamReady = (): WorkflowNodeDef[] => {
    refreshStateNodes();
    const ready: WorkflowNodeDef[] = [];
    for (const node of nodes) {
      if (completed.has(node.key)) continue;
      const incoming = edges.filter((e) => e.target === node.key);
      // ready when every non-skipped incoming edge's source completed
      const pending = incoming.filter((e) => !completed.has(e.source));
      if (pending.length > 0) continue;
      // condition gating: if this node was reached only via a non-matching condition edge, skip it
      const conditioned = incoming.filter((e) => e.condition);
      if (conditioned.length > 0 && conditioned.every((e) => nodeStates.get(e.source)?.output !== e.condition)) {
        completed.add(node.key);
        nodeStates.set(node.key, { output: "(skipped: condition not met)", status: "success" });
        outputs[node.key] = "(skipped)";
        continue;
      }
      ready.push(node);
    }
    return ready;
  };

  const approvalMessage = (node: WorkflowNodeDef) =>
    String(node.config["message"] ?? `Approve step "${node.label || node.key}" to continue the workflow`);

  const executeNode = async (node: WorkflowNodeDef): Promise<void> => {
    const config = node.config ?? {};
    const promptTemplate = String(config["promptTemplate"] ?? "{{input}}");
    switch (node.type) {
      case "input": {
        const text = typeof params.input === "string" ? params.input : JSON.stringify(params.input, null, 2);
        nodeStates.set(node.key, { output: text, status: "success" });
        recordNode(node, text, "success", { kind: "input" });
        return;
      }
      case "agent": {
        const agentId = String(config["agentId"]);
        const prompt = renderTemplate(promptTemplate, state);
        const result = await runAgent(db, router, {
          agentId,
          input: prompt,
          projectId: params.projectId ?? null,
          workflowExecutionId: executionId,
          approveTool: params.approveTool,
          signal: params.signal,
        });
        nodeStates.set(node.key, { output: result.output, status: "success" });
        recordNode(node, result.output, "success", { agentExecutionId: result.executionId });
        return;
      }
      case "model": {
        const modelRowId = String(config["modelRowId"]);
        const prompt = renderTemplate(promptTemplate, state);
        const result = await router.chat({
          modelRowId,
          messages: [
            ...(config["system"] ? [{ role: "system" as const, content: String(config["system"]) }] : []),
            { role: "user" as const, content: prompt },
          ],
          temperature: typeof config["temperature"] === "number" ? config["temperature"] : undefined,
          maxTokens: typeof config["maxTokens"] === "number" ? config["maxTokens"] : undefined,
          workflowExecutionId: executionId,
          signal: params.signal,
        });
        nodeStates.set(node.key, { output: result.content, status: "success" });
        recordNode(node, result.content, "success", { modelRowId });
        return;
      }
      case "tool": {
        const toolIntegrationId = String(config["toolIntegrationId"]);
        const argsTemplate = config["args"] ?? {};
        const args = typeof argsTemplate === "object" && argsTemplate !== null
          ? JSON.parse(renderTemplate(JSON.stringify(argsTemplate), state)) as unknown
          : argsTemplate;
        const result = await executeTool(db, toolIntegrationId, args, { agentExecutionId: undefined });
        if (result.status === "awaiting_approval") {
          throw new ApprovalRequired(node.key, `Tool "${toolIntegrationId}" requires approval`);
        }
        if (result.status !== "success") {
          throw ForgeError.provider(`Tool node "${node.key}" failed: ${result.error ?? result.status}`);
        }
        const text = typeof result.output === "string" ? result.output : JSON.stringify(result.output);
        nodeStates.set(node.key, { output: text, status: "success" });
        recordNode(node, text, "success", { toolIntegrationId });
        return;
      }
      case "condition": {
        const result = evaluateCondition(config, state);
        const text = result ? "true" : "false";
        nodeStates.set(node.key, { output: text, status: "success" });
        recordNode(node, text, "success", { kind: "condition" });
        return;
      }
      case "approval": {
        if (params.approvedNodes?.has(node.key)) {
          const text = "approved";
          nodeStates.set(node.key, { output: text, status: "success" });
          recordNode(node, text, "success", { kind: "approval", approved: true });
          return;
        }
        throw new ApprovalRequired(node.key, approvalMessage(node));
      }
      case "output": {
        const text = typeof config["template"] === "string"
          ? renderTemplate(config["template"], state)
          : JSON.stringify(state.nodes, null, 2);
        nodeStates.set(node.key, { output: text, status: "success" });
        recordNode(node, text, "success", { kind: "output" });
        return;
      }
      default:
        throw ForgeError.validation(`Unsupported node type: ${String((node as WorkflowNodeDef).type)}`);
    }
  };

  let failed = false;
  let firstError: string | undefined;
  for (;;) {
    if (params.signal?.aborted) {
      return { status: "cancelled", output: null, error: "cancelled", outputs };
    }
    const ready = downstreamReady();
    if (ready.length === 0) {
      if (completed.size < nodes.length) {
        // remaining nodes unreachable (skipped branches handled) — mark rest skipped
        for (const node of nodes) {
          if (!completed.has(node.key)) {
            completed.add(node.key);
            nodeStates.set(node.key, { output: "(skipped)", status: "success" });
          }
        }
      }
      break;
    }
    // Execute ready nodes; approval failures pause the run
    try {
      await Promise.all(ready.map(async (node) => {
        try {
          await executeNode(node);
        } catch (err) {
          if (err instanceof ApprovalRequired) throw err;
          const message = err instanceof Error ? err.message : String(err);
          nodeStates.set(node.key, { output: "", status: "failed", error: message });
          recordNode(node, "", "failed", { error: message });
          failed = true;
          firstError ??= `Node "${node.key}" failed: ${message}`;
        } finally {
          completed.add(node.key);
        }
      }));
      for (const node of ready) {
        outputs[node.key] = nodeStates.get(node.key);
      }
    } catch (err) {
      if (err instanceof ApprovalRequired) {
        return {
          status: "awaiting_approval",
          output: null,
          awaitingNodeKey: err.nodeKey,
          error: err.message,
          outputs,
        };
      }
      throw err;
    }
    if (failed) break;
  }

  const outputNodes = nodes.filter((n) => n.type === "output");
  const output = outputNodes.length > 0
    ? Object.fromEntries(outputNodes.map((n) => [n.key, nodeStates.get(n.key)?.output ?? null]))
    : Object.fromEntries(Object.entries(state.nodes).map(([k, v]) => [k, v.output]));

  return {
    status: failed ? "failed" : "success",
    output,
    error: firstError,
    outputs,
  };
}
