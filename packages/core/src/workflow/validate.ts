export type WorkflowNodeType = "input" | "agent" | "model" | "tool" | "condition" | "approval" | "output";

export interface WorkflowNodeDef {
  key: string;
  type: WorkflowNodeType;
  label: string;
  config: Record<string, unknown>;
  position?: { x: number; y: number };
}

export interface WorkflowEdgeDef {
  source: string;
  target: string;
  condition?: "true" | "false" | null;
}

export interface WorkflowDefinition {
  nodes: WorkflowNodeDef[];
  edges: WorkflowEdgeDef[];
}

export interface WorkflowValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

const KNOWN_TYPES: WorkflowNodeType[] = ["input", "agent", "model", "tool", "condition", "approval", "output"];

export function validateWorkflowDefinition(def: WorkflowDefinition): WorkflowValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!Array.isArray(def.nodes) || def.nodes.length === 0) {
    errors.push("Workflow must contain at least one node");
    return { valid: false, errors, warnings };
  }

  const keys = new Set<string>();
  for (const node of def.nodes) {
    if (!node.key || typeof node.key !== "string") errors.push("Every node needs a non-empty string key");
    if (keys.has(node.key)) errors.push(`Duplicate node key: ${node.key}`);
    keys.add(node.key);
    if (!KNOWN_TYPES.includes(node.type)) errors.push(`Node "${node.key}" has unknown type "${String(node.type)}"`);
  }

  const edgeSeen = new Set<string>();
  for (const edge of def.edges ?? []) {
    if (!keys.has(edge.source)) errors.push(`Edge source "${edge.source}" does not reference a node`);
    if (!keys.has(edge.target)) errors.push(`Edge target "${edge.target}" does not reference a node`);
    if (edge.source === edge.target) errors.push(`Node "${edge.source}" cannot connect to itself`);
    const sig = `${edge.source}->${edge.target}:${edge.condition ?? ""}`;
    if (edgeSeen.has(sig)) warnings.push(`Duplicate edge ${sig}`);
    edgeSeen.add(sig);
  }

  // Cycle detection (DFS, white/gray/black). No cycles are permitted.
  const adjacency = new Map<string, string[]>();
  for (const node of def.nodes) adjacency.set(node.key, []);
  for (const edge of def.edges ?? []) {
    if (keys.has(edge.source)) adjacency.get(edge.source)!.push(edge.target);
  }
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>(def.nodes.map((n) => [n.key, WHITE]));
  const stack: string[] = [];
  const dfs = (u: string): void => {
    color.set(u, GRAY);
    stack.push(u);
    for (const v of adjacency.get(u) ?? []) {
      const c = color.get(v);
      if (c === WHITE) dfs(v);
      else if (c === GRAY) {
        const cycleStart = stack.indexOf(v);
        const cycle = [...stack.slice(cycleStart), v].join(" → ");
        errors.push(`Cycle detected: ${cycle}. Workflows must be acyclic.`);
      }
    }
    stack.pop();
    color.set(u, BLACK);
  };
  for (const node of def.nodes) {
    if (color.get(node.key) === WHITE) dfs(node.key);
  }

  // Reachability from input-like roots
  const roots = def.nodes.filter((n) => (def.edges ?? []).every((e) => e.target !== n.key));
  if (roots.length === 0) {
    errors.push("No entry node found (every node has an incoming edge — the graph would never start)");
  }

  // Condition nodes must have conditioned outgoing edges
  for (const node of def.nodes) {
    if (node.type === "condition") {
      const outgoing = (def.edges ?? []).filter((e) => e.source === node.key);
      if (outgoing.length === 0) {
        warnings.push(`Condition node "${node.key}" has no outgoing edges; nothing will run after it`);
      }
      for (const edge of outgoing) {
        if (edge.condition !== "true" && edge.condition !== "false") {
          errors.push(`Condition node "${node.key}" edge to "${edge.target}" must declare condition "true" or "false"`);
        }
      }
    }
    if (node.type === "agent" && typeof node.config["agentId"] !== "string") {
      errors.push(`Agent node "${node.key}" requires config.agentId`);
    }
    if (node.type === "model" && typeof node.config["modelRowId"] !== "string") {
      errors.push(`Model node "${node.key}" requires config.modelRowId`);
    }
    if (node.type === "tool" && typeof node.config["toolIntegrationId"] !== "string") {
      errors.push(`Tool node "${node.key}" requires config.toolIntegrationId`);
    }
  }

  return { valid: errors.length === 0, errors: [...new Set(errors)], warnings };
}
