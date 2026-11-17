import { useEffect, useState } from "react";
import { api, errMessage } from "../api";
import { ConfirmButton, EmptyState, Panel, Spinner, StatusBadge, useToastState } from "../components";
import { ModelOutput } from "../components/ModelOutput";
import type { ModelRow } from "./modelhub/ModelsTab";

export interface AgentRow {
  id: string;
  name: string;
  description: string;
  systemInstructions: string;
  modelId: string | null;
  temperature: number;
  maxTokens: number;
  executionLimit: number;
  isExample: boolean;
  enabled: boolean;
  createdAt: number;
}

interface AgentExecution {
  id: string;
  status: string;
  input: string;
  output: string | null;
  toolCalls: number;
  totalTokens: number | null;
  estimatedCostUsd: number | null;
  latencyMs: number | null;
  createdAt: number;
}

export function Agents() {
  const [agents, setAgents] = useState<AgentRow[] | null>(null);
  const [models, setModels] = useState<ModelRow[]>([]);
  const [selected, setSelected] = useState<AgentRow | null>(null);
  const [executions, setExecutions] = useState<AgentExecution[]>([]);
  const [runInput, setRunInput] = useState("");
  const [approveTools, setApproveTools] = useState(false);
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", systemInstructions: "", modelId: "", temperature: 0.7, maxTokens: 2048 });
  const { show, node } = useToastState();

  const refresh = () => {
    api.get<{ agents: AgentRow[] }>("/api/v1/agents").then((r) => setAgents(r.agents)).catch((e) => show(errMessage(e), { error: true }));
    api.get<{ models: ModelRow[] }>("/api/v1/models").then((r) => setModels(r.models)).catch(() => undefined);
  };
  useEffect(() => { refresh(); }, []);

  useEffect(() => {
    if (!selected) { setExecutions([]); return; }
    api.get<{ executions: AgentExecution[] }>(`/api/v1/agents/${selected.id}/executions`).then((r) => setExecutions(r.executions)).catch(() => undefined);
  }, [selected?.id, runResult]);

  const modelName = (id: string | null) => models.find((m) => m.id === id)?.displayName ?? null;

  const createAgent = async () => {
    try {
      await api.post("/api/v1/agents", { ...form, modelId: form.modelId || null });
      show(`Agent "${form.name}" created.`);
      setShowForm(false);
      setForm({ name: "", description: "", systemInstructions: "", modelId: "", temperature: 0.7, maxTokens: 2048 });
      refresh();
    } catch (e) { show(errMessage(e), { error: true }); }
  };

  const createExamples = async () => {
    try {
      const r = await api.post<{ agents: AgentRow[] }>("/api/v1/agents/examples", {});
      show(`Created ${r.agents.length} example agents (Planner, Research, Coding, Review, Testing, Documentation). They are clearly marked examples and cannot run until you assign a registered model to them.`);
      refresh();
    } catch (e) { show(errMessage(e), { error: true }); }
  };

  const updateAgent = async (id: string, patch: Record<string, unknown>) => {
    try {
      await api.patch(`/api/v1/agents/${id}`, patch);
      refresh();
      if (selected?.id === id) {
        const r = await api.get<{ agent: AgentRow }>(`/api/v1/agents/${id}`);
        setSelected(r.agent);
      }
    } catch (e) { show(errMessage(e), { error: true }); }
  };

  const removeAgent = async (id: string) => {
    try {
      await api.del(`/api/v1/agents/${id}`);
      show("Agent deleted.");
      if (selected?.id === id) setSelected(null);
      refresh();
    } catch (e) { show(errMessage(e), { error: true }); }
  };

  const runSelected = async () => {
    if (!selected || !runInput.trim()) return;
    setRunning(true);
    setRunResult(null);
    try {
      const r = await api.post<{ output: string; usage: { totalTokens: number | null }; toolCalls: number }>(`/api/v1/agents/${selected.id}/run`, { input: runInput, approveTools });
      setRunResult(r.output);
      show(`Completed — ${r.usage.totalTokens ?? "?"} tokens, ${r.toolCalls} tool call(s).`);
    } catch (e) {
      setRunResult(`Error: ${errMessage(e)}`);
      show(errMessage(e), { error: true });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="page">
      {node}
      <div className="page-header">
        <div>
          <div className="page-title">Agents</div>
          <div className="page-sub">Reusable agent configurations with their own model, instructions, limits and tool grants.</div>
        </div>
        <div className="row">
          <button className="btn" onClick={createExamples} title="Explicitly create clearly-labeled example agents. No models are assigned.">Create example agents…</button>
          <button className="btn btn-primary" onClick={() => setShowForm((v) => !v)}>+ New Agent</button>
        </div>
      </div>

      {showForm && (
        <Panel title="Create agent">
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <div className="field"><label className="label">Name *</label><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Code Reviewer" /></div>
            <div className="field"><label className="label">Model</label>
              <select className="input" value={form.modelId} onChange={(e) => setForm({ ...form, modelId: e.target.value })}>
                <option value="">— unassigned (cannot run) —</option>
                {models.filter((m) => m.enabled).map((m) => <option key={m.id} value={m.id}>{m.displayName} ({m.providerName})</option>)}
              </select>
            </div>
          </div>
          <div className="field"><label className="label">Description</label><input className="input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
          <div className="field"><label className="label">System instructions</label><textarea className="input textarea" value={form.systemInstructions} onChange={(e) => setForm({ ...form, systemInstructions: e.target.value })} placeholder="You are a…" /></div>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn" onClick={() => setShowForm(false)}>Cancel</button>
            <button className="btn btn-primary" disabled={!form.name} onClick={createAgent}>Create Agent</button>
          </div>
        </Panel>
      )}

      <div className="two-col" style={{ gridTemplateColumns: "minmax(320px, 5fr) 7fr", marginTop: 12 }}>
        <Panel title="Agents">
          {agents === null ? <Spinner /> : agents.length === 0 ? (
            <EmptyState
              title="No agents yet"
              sub="Create an agent with your own instructions and model, or explicitly create the labeled example set (Planner, Research, Coding, Review, Testing, Documentation). Examples cannot run until you assign a model."
              action={<button className="btn btn-primary" onClick={createExamples}>Create example agents</button>}
            />
          ) : (
            <table className="table">
              <thead><tr><th>Agent</th><th>Model</th><th></th></tr></thead>
              <tbody>
                {agents.map((a) => (
                  <tr key={a.id} onClick={() => setSelected(a)} style={{ cursor: "pointer", background: selected?.id === a.id ? "var(--bg-hover)" : undefined }}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{a.name}{a.isExample && <span className="badge info" style={{ marginLeft: 6 }}>example</span>}</div>
                      <div className="hint">{a.description.slice(0, 90)}</div>
                    </td>
                    <td>{modelName(a.modelId) ?? <span className="badge warn">unassigned</span>}</td>
                    <td><input className="checkbox" type="checkbox" checked={a.enabled} onClick={(e) => e.stopPropagation()} onChange={() => updateAgent(a.id, { enabled: !a.enabled })} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title={selected ? `Run: ${selected.name}` : "Select an agent"}>
          {!selected ? (
            <div className="hint">Select an agent on the left to run it and view its configuration and recent executions.</div>
          ) : (
            <>
              <div className="field"><label className="label">Model</label>
                <select className="input" value={selected.modelId ?? ""} onChange={(e) => updateAgent(selected.id, { modelId: e.target.value || null })}>
                  <option value="">— unassigned (cannot run) —</option>
                  {models.map((m) => <option key={m.id} value={m.id}>{m.displayName} ({m.providerName})</option>)}
                </select>
              </div>
              <div className="field"><label className="label">System instructions</label>
                <textarea className="input textarea" value={selected.systemInstructions} onChange={(e) => setSelected({ ...selected, systemInstructions: e.target.value })} onBlur={() => updateAgent(selected.id, { systemInstructions: selected.systemInstructions })} />
              </div>
              <div className="grid" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
                <div className="field"><label className="label">Temperature</label><input className="input" type="number" step="0.05" min={0} max={2} value={selected.temperature} onChange={(e) => setSelected({ ...selected, temperature: Number(e.target.value) })} onBlur={() => updateAgent(selected.id, { temperature: selected.temperature })} /></div>
                <div className="field"><label className="label">Max tokens</label><input className="input" type="number" value={selected.maxTokens} onChange={(e) => setSelected({ ...selected, maxTokens: Number(e.target.value) })} onBlur={() => updateAgent(selected.id, { maxTokens: selected.maxTokens })} /></div>
                <div className="field"><label className="label">Execution limit</label><input className="input" type="number" min={1} max={50} value={selected.executionLimit} onChange={(e) => setSelected({ ...selected, executionLimit: Number(e.target.value) })} onBlur={() => updateAgent(selected.id, { executionLimit: selected.executionLimit })} /></div>
              </div>

              <hr className="divider" />
              <div className="field"><label className="label">Input</label>
                <textarea className="input textarea" style={{ minHeight: 70 }} value={runInput} onChange={(e) => setRunInput(e.target.value)} placeholder="Task for this agent…" />
              </div>
              <label className="row" style={{ gap: 6, marginBottom: 10, fontSize: 11, color: "var(--text-dim)" }}>
                <input className="checkbox" type="checkbox" checked={approveTools} onChange={(e) => setApproveTools(e.target.checked)} />
                Auto-approve tool calls for this run (explicit opt-in; only tools granted to this agent can run)
              </label>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <ConfirmButton label="Delete agent" onConfirm={() => removeAgent(selected.id)} />
                <button className="btn btn-primary" disabled={!selected.modelId || !runInput.trim() || running} onClick={runSelected}>{running ? <><Spinner /> Running…</> : "Run Agent"}</button>
              </div>
              {runResult && <><hr className="divider" /><div className="panel-title">Output</div><ModelOutput content={runResult} maxHeight={400} /></>}

              {executions.length > 0 && (
                <>
                  <hr className="divider" />
                  <div className="panel-title">Recent executions</div>
                  <table className="table">
                    <thead><tr><th>When</th><th>Status</th><th>Tokens</th><th>Latency</th><th>Cost (est.)</th></tr></thead>
                    <tbody>
                      {executions.slice(0, 6).map((ex) => (
                        <tr key={ex.id}>
                          <td className="hint">{new Date(ex.createdAt).toLocaleString()}</td>
                          <td><StatusBadge status={ex.status} /></td>
                          <td>{ex.totalTokens ?? "—"}</td>
                          <td>{ex.latencyMs != null ? `${ex.latencyMs} ms` : "—"}</td>
                          <td>{ex.estimatedCostUsd != null ? `$${ex.estimatedCostUsd.toFixed(6)}` : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </>
          )}
        </Panel>
      </div>
    </div>
  );
}
