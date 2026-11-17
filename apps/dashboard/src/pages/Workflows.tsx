import { useCallback, useEffect, useRef, useState } from "react";
import { api, errMessage } from "../api";
import { ConfirmButton, Panel, Spinner, StatusBadge, useToastState } from "../components";
import { CodeBlock } from "../components/CodeBlock";
import { ModelOutput } from "../components/ModelOutput";
import type { AgentRow } from "./Agents";
import type { ModelRow } from "./modelhub/ModelsTab";

type NodeType = "input" | "agent" | "model" | "tool" | "condition" | "approval" | "output";
interface CanvasNode {
  key: string;
  type: NodeType;
  label: string;
  config: Record<string, unknown>;
  position: { x: number; y: number };
}
interface CanvasEdge {
  source: string;
  target: string;
  condition?: "true" | "false" | null;
}

const NODE_COLORS: Record<NodeType, string> = {
  input: "#5ea0e8",
  agent: "#e8b34b",
  model: "#b18cff",
  tool: "#3ecf8e",
  condition: "#f2915e",
  approval: "#e5484d",
  output: "#9aa3b5",
};
const NODE_W = 150;
const NODE_H = 56;

let keyCounter = 1;
const nextKey = (t: string) => `${t}_${keyCounter++}_${Date.now().toString(36)}`;

export function Workflows() {
  const [workflows, setWorkflows] = useState<Array<{ id: string; name: string; latestVersion: number; enabled: boolean }> | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [currentName, setCurrentName] = useState("");
  const [nodes, setNodes] = useState<CanvasNode[]>([]);
  const [edges, setEdges] = useState<CanvasEdge[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [newWorkflowName, setNewWorkflowName] = useState("");
  const [runInput, setRunInput] = useState("");
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<{ executionId: string; status: string; output?: unknown; awaitingNodeKey?: string; error?: string } | null>(null);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [models, setModels] = useState<ModelRow[]>([]);
  const [tools, setTools] = useState<Array<{ id: string; name: string; enabled: boolean }>>([]);
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ key: string; dx: number; dy: number } | null>(null);
  const { show, node } = useToastState();

  useEffect(() => {
    api.get<{ workflows: Array<{ id: string; name: string; latestVersion: number; enabled: boolean }> }>("/api/v1/workflows").then((r) => setWorkflows(r.workflows)).catch(() => undefined);
    api.get<{ agents: AgentRow[] }>("/api/v1/agents").then((r) => setAgents(r.agents)).catch(() => undefined);
    api.get<{ models: ModelRow[] }>("/api/v1/models").then((r) => setModels(r.models)).catch(() => undefined);
    api.get<{ tools: Array<{ id: string; name: string; enabled: boolean }> }>("/api/v1/tools").then((r) => setTools(r.tools)).catch(() => undefined);
  }, [currentId]);

  const selectWorkflow = async (id: string) => {
    setCurrentId(id);
    setRunResult(null);
    const r = await api.get<{ workflow: { name: string }; definition: { nodes: CanvasNode[]; edges: CanvasEdge[] } | null }>(`/api/v1/workflows/${id}`);
    setCurrentName(r.workflow.name);
    if (r.definition) {
      setNodes(r.definition.nodes.map((n) => ({ ...n, position: n.position ?? { x: 40 + Math.random() * 300, y: 40 + Math.random() * 240 } })));
      setEdges(r.definition.edges);
    } else {
      setNodes([{ key: "input_1", type: "input", label: "Input", config: {}, position: { x: 30, y: 120 } }]);
      setEdges([]);
    }
    setSelectedKey(null);
  };

  const createWorkflow = async () => {
    if (!newWorkflowName.trim()) return;
    try {
      const r = await api.post<{ workflow: { id: string } }>("/api/v1/workflows", { name: newWorkflowName.trim() });
      setNewWorkflowName("");
      await selectWorkflow(r.workflow.id);
    } catch (e) { show(errMessage(e), { error: true }); }
  };

  const deleteWorkflow = async () => {
    if (!currentId) return;
    try {
      await api.del(`/api/v1/workflows/${currentId}`);
      setCurrentId(null);
      setNodes([]);
      setEdges([]);
      show("Workflow deleted.");
    } catch (e) { show(errMessage(e), { error: true }); }
  };

  const addNode = (type: NodeType) => {
    const key = nextKey(type);
    const labels: Record<NodeType, string> = { input: "Input", agent: "Agent", model: "Model", tool: "Tool", condition: "Condition", approval: "Approval", output: "Output" };
    setNodes((n) => [...n, { key, type, label: labels[type], config: {}, position: { x: 60 + Math.random() * 320, y: 60 + Math.random() * 240 } }]);
    setSelectedKey(key);
  };

  const removeNode = (key: string) => {
    setNodes((n) => n.filter((x) => x.key !== key));
    setEdges((e) => e.filter((x) => x.source !== key && x.target !== key));
    if (selectedKey === key) setSelectedKey(null);
  };

  const connectNodes = (targetKey: string, condition?: "true" | "false") => {
    if (!connectFrom || connectFrom === targetKey) return;
    if (edges.some((e) => e.source === connectFrom && e.target === targetKey && (e.condition ?? null) === (condition ?? null))) {
      setConnectFrom(null);
      return;
    }
    setEdges((e) => [...e, { source: connectFrom, target: targetKey, condition: condition ?? null }]);
    setConnectFrom(null);
  };

  const removeEdge = (source: string, target: string, condition?: string | null) => {
    setEdges((e) => e.filter((x) => !(x.source === source && x.target === target && (x.condition ?? null) === (condition ?? null))));
  };

  const selected = nodes.find((n) => n.key === selectedKey) ?? null;
  const updateSelectedConfig = (patch: Record<string, unknown>) => {
    setNodes((n) => n.map((x) => (x.key === selectedKey ? { ...x, config: { ...x.config, ...patch } } : x)));
  };

  const definition = { nodes: nodes.map((n) => ({ key: n.key, type: n.type, label: n.label, config: n.config, position: n.position })), edges };

  const saveVersion = async () => {
    if (!currentId) return;
    try {
      const validation = await api.post<{ valid: boolean; errors: string[]; warnings: string[] }>(`/api/v1/workflows/${currentId}/validate`, definition);
      if (!validation.valid) {
        show(`Invalid workflow:\n${validation.errors.join("\n")}`, { error: true });
        return;
      }
      const result = await api.post<{ version: number; warnings: string[] }>(`/api/v1/workflows/${currentId}/versions`, definition);
      show(`Version ${result.version} saved and validated.${result.warnings.length ? ` Warnings: ${result.warnings.join("; ")}` : ""}`);
      const r = await api.get<{ workflows: typeof workflows }>("/api/v1/workflows");
      setWorkflows(r.workflows);
    } catch (e) { show(errMessage(e), { error: true }); }
  };

  const runWorkflow = async (approvedNodes?: string[]) => {
    if (!currentId) return;
    setRunning(true);
    setRunResult(null);
    try {
      const r = await api.post<{ executionId: string; status: string; output?: unknown; awaitingNodeKey?: string; error?: string }>(`/api/v1/workflows/${currentId}/run`, {
        input: runInput,
        approvedNodes,
      });
      setRunResult(r);
    } catch (e) { show(errMessage(e), { error: true }); } finally { setRunning(false); }
  };

  const approveNode = async () => {
    if (!runResult?.executionId) return;
    setRunning(true);
    try {
      const r = await api.post<{ status: string; output?: unknown; awaitingNodeKey?: string }>(`/api/v1/workflows/executions/${runResult.executionId}/approve`, {});
      setRunResult({ ...runResult, ...r });
    } catch (e) { show(errMessage(e), { error: true }); } finally { setRunning(false); }
  };

  // Node dragging on canvas
  const onNodeMouseDown = (e: React.MouseEvent, key: string) => {
    const nodeEl = nodes.find((n) => n.key === key);
    if (!nodeEl) return;
    const startX = e.clientX, startY = e.clientY, ox = nodeEl.position.x, oy = nodeEl.position.y;
    dragRef.current = { key, dx: 0, dy: 0 };
    const move = (ev: MouseEvent) => {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      setNodes((n) => n.map((x) => (x.key === key ? { ...x, position: { x: Math.max(0, ox + dx), y: Math.max(0, oy + dy) } } : x)));
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const canvasH = Math.max(460, ...nodes.map((n) => n.position.y + NODE_H + 60));

  return (
    <div className="page" style={{ maxWidth: "none" }}>
      {node}
      <div className="page-header">
        <div>
          <div className="page-title">Workflows</div>
          <div className="page-sub">Versioned, validated, acyclic execution graphs. Approval nodes pause for your explicit go-ahead.</div>
        </div>
        <div className="row">
          <input className="input" style={{ width: 200 }} placeholder="New workflow name…" value={newWorkflowName} onChange={(e) => setNewWorkflowName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && createWorkflow()} />
          <button className="btn btn-primary" onClick={createWorkflow}>+ Create</button>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "230px 1fr 300px", alignItems: "start" }}>
        {/* Sidebar: workflow list */}
        <Panel title="Workflows">
          {workflows === null ? <Spinner /> : workflows.length === 0 ? (
            <div className="hint">No workflows yet. Create one to chain agents, tools and approvals into a versioned graph.</div>
          ) : (
            workflows.map((w) => (
              <button key={w.id} className="btn" style={{ width: "100%", justifyContent: "space-between", marginBottom: 6, borderColor: currentId === w.id ? "var(--accent-dim)" : undefined }} onClick={() => selectWorkflow(w.id)}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{w.name}</span>
                <span className="badge">v{w.latestVersion}</span>
              </button>
            ))
          )}
        </Panel>

        {/* Canvas */}
        <Panel title={currentId ? `Canvas — ${currentName}` : "Canvas"} actions={
          currentId ? (
            <div className="row">
              <button className="btn btn-small" onClick={saveVersion}>Validate &amp; Save</button>
              <ConfirmButton label="Delete" onConfirm={deleteWorkflow} />
            </div>
          ) : undefined
        }>
          {!currentId ? (
            <div className="hint">Select or create a workflow to edit it.</div>
          ) : (
            <>
              <div className="row" style={{ flexWrap: "wrap", marginBottom: 8, gap: 4 }}>
                {(Object.keys(NODE_COLORS) as NodeType[]).map((t) => (
                  <button key={t} className="btn btn-small" onClick={() => addNode(t)}>+ {t}</button>
                ))}
                {connectFrom && <span className="badge warn">Connecting from “{connectFrom}” — click a target node…</span>}
              </div>
              <div ref={canvasRef} style={{ position: "relative", height: canvasH, background: "#0d1016", border: "1px solid var(--border)", borderRadius: 6, overflow: "auto", userSelect: "none" }}>
                {/* edges */}
                <svg style={{ position: "absolute", inset: 0, width: "100%", height: canvasH }}>
                  {edges.map((e, i) => {
                    const s = nodes.find((n) => n.key === e.source);
                    const t = nodes.find((n) => n.key === e.target);
                    if (!s || !t) return null;
                    const x1 = s.position.x + NODE_W, y1 = s.position.y + NODE_H / 2;
                    const x2 = t.position.x, y2 = t.position.y + NODE_H / 2;
                    const mx = (x1 + x2) / 2;
                    return (
                      <g key={i}>
                        <path d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`} fill="none" stroke="#3a4358" strokeWidth={1.6} markerEnd="url(#arrow)" />
                        {e.condition && <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 4} fill="#e8b34b" fontSize="10" textAnchor="middle" fontFamily="var(--mono)">{e.condition}</text>}
                      </g>
                    );
                  })}
                  <defs>
                    <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#3a4358" /></marker>
                  </defs>
                </svg>
                {/* nodes */}
                {nodes.map((n) => (
                  <div
                    key={n.key}
                    onMouseDown={(e) => onNodeMouseDown(e, n.key)}
                    onClick={() => (connectFrom ? connectNodes(n.key) : setSelectedKey(n.key))}
                    style={{
                      position: "absolute", left: n.position.x, top: n.position.y, width: NODE_W, height: NODE_H,
                      background: "var(--bg-panel)", border: `1.5px solid ${selectedKey === n.key ? "var(--accent)" : "var(--border-strong)"}`,
                      borderLeft: `3px solid ${NODE_COLORS[n.type]}`, borderRadius: 6, padding: "6px 10px", cursor: "move",
                    }}
                  >
                    <div className="mono" style={{ fontSize: 9, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: ".1em" }}>{n.type}</div>
                    <div style={{ fontWeight: 600, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n.label}</div>
                    <button className="btn btn-small btn-ghost" style={{ position: "absolute", right: 2, bottom: 2, fontSize: 9, padding: "1px 6px" }} onClick={(e) => { e.stopPropagation(); setConnectFrom(n.key); }}>connect →</button>
                  </div>
                ))}
              </div>
              {edges.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <div className="label">Edges</div>
                  {edges.map((e, i) => (
                    <div key={i} className="row" style={{ justifyContent: "space-between", padding: "3px 0", borderBottom: "1px solid var(--border)" }}>
                      <span className="mono" style={{ fontSize: 10.5 }}>{e.source} → {e.target}{e.condition ? ` [${e.condition}]` : ""}</span>
                      <button className="btn btn-small btn-ghost" onClick={() => removeEdge(e.source, e.target, e.condition)}>✕</button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </Panel>

        {/* Inspector */}
        <Panel title="Inspector">
          {!selected ? (
            <div className="hint">Select a node to configure it. Edges from a condition node must carry “true”/“false” conditions.</div>
          ) : (
            <>
              <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
                <span className="badge info">{selected.type}</span>
                <button className="btn btn-small btn-danger" onClick={() => removeNode(selected.key)}>Remove node</button>
              </div>
              <div className="field"><label className="label">Label</label><input className="input" value={selected.label} onChange={(e) => setNodes((n) => n.map((x) => (x.key === selected.key ? { ...x, label: e.target.value } : x)))} /></div>

              {selected.type === "agent" && (
                <>
                  <div className="field"><label className="label">Agent *</label>
                    <select className="input" value={String(selected.config["agentId"] ?? "")} onChange={(e) => updateSelectedConfig({ agentId: e.target.value })}>
                      <option value="">Select agent…</option>
                      {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                  </div>
                  <PromptTemplateEditor value={String(selected.config["promptTemplate"] ?? "{{input}}")} onChange={(v) => updateSelectedConfig({ promptTemplate: v })} />
                </>
              )}
              {selected.type === "model" && (
                <>
                  <div className="field"><label className="label">Model *</label>
                    <select className="input" value={String(selected.config["modelRowId"] ?? "")} onChange={(e) => updateSelectedConfig({ modelRowId: e.target.value })}>
                      <option value="">Select model…</option>
                      {models.map((m) => <option key={m.id} value={m.id}>{m.displayName} ({m.providerName})</option>)}
                    </select>
                  </div>
                  <PromptTemplateEditor value={String(selected.config["promptTemplate"] ?? "{{input}}")} onChange={(v) => updateSelectedConfig({ promptTemplate: v })} />
                  <div className="field"><label className="label">System prompt (optional)</label><textarea className="input textarea" style={{ minHeight: 60 }} value={String(selected.config["system"] ?? "")} onChange={(e) => updateSelectedConfig({ system: e.target.value })} /></div>
                </>
              )}
              {selected.type === "tool" && (
                <>
                  <div className="field"><label className="label">Tool *</label>
                    <select className="input" value={String(selected.config["toolIntegrationId"] ?? "")} onChange={(e) => updateSelectedConfig({ toolIntegrationId: e.target.value })}>
                      <option value="">Select tool…</option>
                      {tools.map((t) => <option key={t.id} value={t.id}>{t.name}{t.enabled ? "" : " (disabled)"}</option>)}
                    </select>
                  </div>
                  <div className="field"><label className="label">Args (JSON; supports {"{{input}}"} / {"{{nodes.key.output}}"})</label><textarea className="input textarea" value={JSON.stringify(selected.config["args"] ?? {}, null, 2)} onChange={(e) => { try { updateSelectedConfig({ args: JSON.parse(e.target.value) }); } catch { /* keep raw until valid */ } }} /></div>
                </>
              )}
              {selected.type === "condition" && (
                <>
                  <div className="field"><label className="label">Field</label>
                    <input className="input mono" value={String(selected.config["field"] ?? "input")} onChange={(e) => updateSelectedConfig({ field: e.target.value })} placeholder="input · nodes.agent_x.output" />
                  </div>
                  <div className="field"><label className="label">Operator</label>
                    <select className="input" value={String(selected.config["operator"] ?? "truthy")} onChange={(e) => updateSelectedConfig({ operator: e.target.value })}>
                      {["truthy", "falsy", "eq", "neq", "contains", "not_contains", "gt", "gte", "lt", "lte"].map((op) => <option key={op} value={op}>{op}</option>)}
                    </select>
                  </div>
                  <div className="field"><label className="label">Value (for eq/contains/…)</label><input className="input" value={String(selected.config["value"] ?? "")} onChange={(e) => updateSelectedConfig({ value: e.target.value })} /></div>
                  <div className="hint">Wire two edges out of this node with conditions “true” and “false”.</div>
                </>
              )}
              {selected.type === "approval" && (
                <div className="field"><label className="label">Approval message</label><textarea className="input textarea" style={{ minHeight: 60 }} value={String(selected.config["message"] ?? "")} onChange={(e) => updateSelectedConfig({ message: e.target.value })} placeholder="Approve to continue…" /></div>
              )}
              {selected.type === "output" && (
                <PromptTemplateEditor label="Output template" value={String(selected.config["template"] ?? "{{nodes}}")} onChange={(v) => updateSelectedConfig({ template: v })} />
              )}
              {selected.type === "input" && <div className="hint">The input node passes the run input into the graph. Use {"{{input}}"} in templates.</div>}

              <hr className="divider" />
              <div className="panel-title">Run</div>
              <textarea className="input textarea" style={{ minHeight: 60 }} value={runInput} onChange={(e) => setRunInput(e.target.value)} placeholder="Input for this run…" />
              <button className="btn btn-primary" style={{ marginTop: 8, width: "100%" }} disabled={running} onClick={() => runWorkflow()}>{running ? <Spinner /> : "Run workflow"}</button>
              {runResult && (
                <div style={{ marginTop: 10 }}>
                  <StatusBadge status={runResult.status} />
                  {runResult.status === "awaiting_approval" && (
                    <div style={{ marginTop: 8 }}>
                      <div className="hint">Paused at approval node <b>{runResult.awaitingNodeKey}</b>.</div>
                      <button className="btn btn-primary" style={{ marginTop: 6 }} onClick={approveNode} disabled={running}>Approve &amp; continue</button>
                    </div>
                  )}
                  {runResult.error && <CodeBlock code={runResult.error} language="text" maxHeight={220} className="" />}
                  {runResult.output != null && runResult.status === "success" && (typeof runResult.output === "string"
                    ? <ModelOutput content={runResult.output} maxHeight={220} />
                    : <CodeBlock code={JSON.stringify(runResult.output, null, 2)} language="json" maxHeight={220} />)}
                </div>
              )}
            </>
          )}
        </Panel>
      </div>
    </div>
  );
}

function PromptTemplateEditor({ value, onChange, label }: { value: string; onChange: (v: string) => void; label?: string }) {
  return (
    <div className="field">
      <label className="label">{label ?? "Prompt template"}</label>
      <textarea className="input textarea" style={{ minHeight: 80 }} value={value} onChange={(e) => onChange(e.target.value)} />
      <div className="hint">Placeholders: <code>{"{{input}}"}</code>, <code>{"{{nodes.<key>.output}}"}</code></div>
    </div>
  );
}
