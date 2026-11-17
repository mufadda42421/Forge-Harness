import { useEffect, useState } from "react";
import { api, errMessage } from "../api";
import { ConfirmButton, Panel, Spinner, useToastState } from "../components";
import { CodeBlock } from "../components/CodeBlock";

interface ToolRow {
  id: string;
  name: string;
  type: string;
  description: string;
  permission: string;
  requiresApproval: boolean;
  timeoutMs: number;
  enabled: boolean;
  config: Record<string, unknown>;
}
interface ToolLog { id: string; toolIntegrationId: string | null; status: string; durationMs: number | null; createdAt: number; error: string | null }

export function ToolsMcp() {
  const [tools, setTools] = useState<ToolRow[] | null>(null);
  const [logs, setLogs] = useState<ToolLog[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", type: "http", description: "", permission: "read-only", requiresApproval: true, config: '{"url": "", "method": "GET"}', inputSchema: "" , timeoutMs: 30000});
  const [execTool, setExecTool] = useState<ToolRow | null>(null);
  const [execArgs, setExecArgs] = useState("{}");
  const [execApproved, setExecApproved] = useState(false);
  const [execResult, setExecResult] = useState<string | null>(null);
  const { show, node } = useToastState();

  const refresh = () => {
    api.get<{ tools: ToolRow[] }>("/api/v1/tools").then((r) => setTools(r.tools)).catch((e) => show(errMessage(e), { error: true }));
    api.get<{ logs: ToolLog[] }>("/api/v1/tools/logs").then((r) => setLogs(r.logs.slice(0, 15))).catch(() => undefined);
  };
  useEffect(() => { refresh(); }, []);

  const createTool = async () => {
    try {
      let config: Record<string, unknown> = {};
      try { config = JSON.parse(form.config) as Record<string, unknown>; } catch { show("config must be valid JSON", { error: true }); return; }
      let inputSchema: Record<string, unknown> | undefined;
      if (form.inputSchema.trim()) {
        try { inputSchema = JSON.parse(form.inputSchema) as Record<string, unknown>; } catch { show("inputSchema must be valid JSON", { error: true }); return; }
      }
      await api.post("/api/v1/tools", {
        name: form.name,
        type: form.type,
        description: form.description,
        config,
        permission: form.permission,
        requiresApproval: form.requiresApproval,
        timeoutMs: Number(form.timeoutMs),
        inputSchema: inputSchema ?? { type: "object", properties: { url: { type: "string" } } },
      });
      show(`Tool "${form.name}" registered. Agents still cannot use it until you grant it per-agent (Agents → tool grants).`);
      setShowForm(false);
      setForm({ ...form, name: "", description: "" });
      refresh();
    } catch (e) { show(errMessage(e), { error: true }); }
  };

  const execute = async () => {
    if (!execTool) return;
    setExecResult(null);
    try {
      const args = JSON.parse(execArgs || "{}") as Record<string, unknown>;
      const r = await api.post<{ status: string; output?: unknown; error?: string }>(`/api/v1/tools/${execTool.id}/execute`, { args, approved: execApproved });
      setExecResult(JSON.stringify(r, null, 2));
      refresh();
    } catch (e) {
      setExecResult(JSON.stringify({ error: errMessage(e) }, null, 2));
    }
  };

  return (
    <div className="page">
      {node}
      <div className="page-header">
        <div>
          <div className="page-title">Tools &amp; MCP</div>
          <div className="page-sub">Permissioned tool registry. Agents receive no tools until you grant them individually; dangerous tools always ask first.</div>
        </div>
        <button className="btn btn-primary" onClick={() => setShowForm((v) => !v)}>+ Register Tool</button>
      </div>

      {showForm && (
        <Panel title="Register tool">
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <div className="field"><label className="label">Name * (machine name)</label><input className="input mono" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="http_request" /></div>
            <div className="field"><label className="label">Type</label>
              <select className="input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                {["http", "mcp", "filesystem", "terminal", "git", "custom"].map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          </div>
          <div className="field"><label className="label">Description</label><input className="input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Fetches a URL and returns the body (truncated)" /></div>
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
            <div className="field"><label className="label">Permission tier</label>
              <select className="input" value={form.permission} onChange={(e) => setForm({ ...form, permission: e.target.value })}>
                <option value="read-only">read-only</option><option value="standard">standard</option><option value="dangerous">dangerous (always approval)</option>
              </select>
            </div>
            <div className="field"><label className="label">Timeout (ms)</label><input className="input" type="number" value={form.timeoutMs} onChange={(e) => setForm({ ...form, timeoutMs: Number(e.target.value) })} /></div>
            <div className="field"><label className="label">Requires approval</label><label className="row" style={{ gap: 6 }}><input className="checkbox" type="checkbox" checked={form.requiresApproval} onChange={(e) => setForm({ ...form, requiresApproval: e.target.checked })} /> <span className="hint">ask before every run</span></label></div>
          </div>
          <div className="field"><label className="label">Config (JSON)</label>
            <textarea className="input textarea" value={form.config} onChange={(e) => setForm({ ...form, config: e.target.value })} />
            <div className="hint">http: <code>{'{"url": "https://api.example.com/x", "method": "GET", "headers": {}}'}</code> · mcp (stdio): <code>{'{"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"], "env": {}}'}</code></div>
          </div>
          <div className="field"><label className="label">Input schema (JSON Schema, optional)</label><textarea className="input textarea" style={{ minHeight: 60 }} value={form.inputSchema} onChange={(e) => setForm({ ...form, inputSchema: e.target.value })} placeholder='{"type":"object","properties":{"url":{"type":"string"}}}' /></div>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn" onClick={() => setShowForm(false)}>Cancel</button>
            <button className="btn btn-primary" disabled={!form.name.trim()} onClick={createTool}>Register Tool</button>
          </div>
        </Panel>
      )}

      {tools === null ? <Spinner /> : tools.length === 0 ? (
        <Panel title="No tools registered">
          <div className="hint">Tools extend agents — HTTP calls, MCP servers, filesystem/terminal/git bridges. A good first tool is an <code>http_request</code> GET tool with read-only permission. Grant tools to agents individually afterwards.</div>
        </Panel>
      ) : (
        <Panel title={`Registered tools (${tools.length})`}>
          <table className="table">
            <thead><tr><th>Tool</th><th>Type</th><th>Permission</th><th>Approval</th><th>Enabled</th><th style={{ textAlign: "right" }}>Actions</th></tr></thead>
            <tbody>
              {tools.map((t) => (
                <tr key={t.id}>
                  <td><div style={{ fontWeight: 600 }}>{t.name}</div><div className="hint">{t.description}</div><div className="mono hint">{JSON.stringify(t.config).slice(0, 100)}</div></td>
                  <td><span className="badge info">{t.type}</span></td>
                  <td><span className={`badge ${t.permission === "dangerous" ? "err" : t.permission === "standard" ? "warn" : "ok"}`}>{t.permission}</span></td>
                  <td>{t.requiresApproval ? "ask" : "auto (if policy allows)"}</td>
                  <td><input className="checkbox" type="checkbox" checked={t.enabled} onChange={async () => { await api.patch(`/api/v1/tools/${t.id}`, { enabled: !t.enabled }); refresh(); }} /></td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <button className="btn btn-small" onClick={() => { setExecTool(t); setExecResult(null); }}>Execute…</button>{" "}
                    <ConfirmButton label="Delete" onConfirm={async () => { await api.del(`/api/v1/tools/${t.id}`); refresh(); }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      {execTool && (
        <Panel title={`Execute: ${execTool.name}`}>
          <div className="field"><label className="label">Arguments (JSON)</label><textarea className="input textarea" value={execArgs} onChange={(e) => setExecArgs(e.target.value)} /></div>
          <label className="row" style={{ gap: 6, fontSize: 11, color: "var(--text-dim)", marginBottom: 8 }}>
            <input className="checkbox" type="checkbox" checked={execApproved} onChange={(e) => setExecApproved(e.target.checked)} />
            Approve this execution (required for tools that ask; dangerous tools always require this)
          </label>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <button className="btn" onClick={() => setExecTool(null)}>Close</button>
            <button className="btn btn-primary" onClick={execute}>Execute</button>
          </div>
          {execResult && <CodeBlock code={execResult} language="json" maxHeight={340} className="" />}
        </Panel>
      )}

      <Panel title="Recent executions" >
        {logs.length === 0 ? <div className="hint">No tool executions yet.</div> : (
          <table className="table">
            <thead><tr><th>Time</th><th>Status</th><th>Duration</th><th>Error</th></tr></thead>
            <tbody>
              {logs.map((l) => (
                <tr key={l.id}>
                  <td className="hint">{new Date(l.createdAt).toLocaleString()}</td>
                  <td><span className={`badge ${l.status === "success" ? "ok" : l.status === "awaiting_approval" ? "warn" : "err"}`}>{l.status}</span></td>
                  <td>{l.durationMs != null ? `${l.durationMs} ms` : "—"}</td>
                  <td className="hint">{l.error?.slice(0, 120) ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
