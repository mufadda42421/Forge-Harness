import { useEffect, useState } from "react";
import { api, errMessage } from "../api";
import { ConfirmButton, Panel, Spinner, StatusBadge, useToastState } from "../components";
import { ModelOutput } from "../components/ModelOutput";

interface Connection {
  id: string; name: string; baseUrl: string; enabled: boolean;
  connectionStatus: string; lastTestedAt: number | null; lastError: string | null; hasCredential: boolean;
}
interface Session { id: string; title: string; time?: { created?: number } }

export function OpenCode() {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [promptResult, setPromptResult] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "Local OpenCode", baseUrl: "http://127.0.0.1:4096", username: "", password: "" });
  const { show, node } = useToastState();

  const refresh = () => api.get<{ connections: Connection[] }>("/api/v1/opencode/connections").then((r) => {
    setConnections(r.connections);
    if (!selectedId && r.connections[0]) setSelectedId(r.connections[0].id);
  }).catch((e) => show(errMessage(e), { error: true }));
  useEffect(() => { refresh(); }, []);

  const selected = connections?.find((c) => c.id === selectedId) ?? null;

  useEffect(() => {
    if (!selectedId) { setSessions(null); return; }
    api.get<{ sessions: Session[] }>(`/api/v1/opencode/connections/${selectedId}/sessions`).then((r) => setSessions(r.sessions)).catch(() => setSessions([]));
  }, [selectedId, busy]);

  const create = async () => {
    try {
      const r = await api.post<{ connection: Connection }>("/api/v1/opencode/connections", {
        name: form.name,
        baseUrl: form.baseUrl,
        username: form.username || undefined,
        password: form.password || undefined,
      });
      show(`Connection "${form.name}" saved. Run a connectivity test.`);
      setShowForm(false);
      setForm({ ...form, password: "" });
      setSelectedId(r.connection.id);
      refresh();
    } catch (e) { show(errMessage(e), { error: true }); }
  };

  const test = async (c: Connection) => {
    setBusy(c.id);
    try {
      const r = await api.post<{ ok: boolean; latencyMs?: number; detail?: string; error?: { message: string } }>(`/api/v1/opencode/connections/${c.id}/test`, {});
      if (r.ok) show(`✓ ${c.name}: ${r.detail ?? "reachable"} (${r.latencyMs} ms)`);
      else show(`✗ ${c.name}: ${r.error?.message ?? "unreachable"}`, { error: true });
      refresh();
    } catch (e) { show(errMessage(e), { error: true }); refresh(); } finally { setBusy(null); }
  };

  const createSession = async () => {
    if (!selectedId) return;
    try {
      const r = await api.post<{ session: Session }>(`/api/v1/opencode/connections/${selectedId}/sessions`, { title: "Forge Harness session" });
      setSessionId(r.session.id);
      show(`Session created: ${r.session.id.slice(0, 12)}…`);
      setBusy(`s${Date.now()}`);
    } catch (e) { show(errMessage(e), { error: true }); }
  };

  const sendPrompt = async () => {
    if (!selectedId || !sessionId || !prompt.trim()) return;
    setBusy("prompt");
    setPromptResult(null);
    try {
      const r = await api.post<{ result: unknown }>(`/api/v1/opencode/connections/${selectedId}/sessions/${sessionId}/prompt`, { text: prompt });
      setPromptResult(typeof r.result === "string" ? r.result : JSON.stringify(r.result, null, 2));
    } catch (e) {
      setPromptResult(`Error: ${errMessage(e)}`);
      show(errMessage(e), { error: true });
    } finally { setBusy(null); }
  };

  return (
    <div className="page">
      {node}
      <div className="page-header">
        <div>
          <div className="page-title">OpenCode</div>
          <div className="page-sub">Optional coordination with a running OpenCode server via the official @opencode-ai/sdk. Forge Harness works fully without it.</div>
        </div>
        <button className="btn btn-primary" onClick={() => setShowForm((v) => !v)}>+ Add Connection</button>
      </div>

      {showForm && (
        <Panel title="Add OpenCode connection">
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <div className="field"><label className="label">Name</label><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div className="field"><label className="label">Server base URL</label><input className="input mono" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="http://127.0.0.1:4096" /></div>
          </div>
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <div className="field"><label className="label">Basic-auth username (optional)</label><input className="input" autoComplete="off" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></div>
            <div className="field"><label className="label">Basic-auth password (optional, encrypted)</label><input className="input" type="password" autoComplete="off" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="stored AES-256-GCM, never shown" /></div>
          </div>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn" onClick={() => setShowForm(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={create}>Save Connection</button>
          </div>
        </Panel>
      )}

      {connections === null ? <Spinner /> : connections.length === 0 ? (
        <Panel title="OpenCode is not connected">
          <div className="hint">
            Start a server with <code>opencode serve</code> (default port 4096), then add a connection above. Forge Harness never assumes a server exists and everything else in the app works without one.
            Once connected, coding agents can hand implementation steps to OpenCode sessions, and you can prompt, inspect and abort sessions from here.
          </div>
        </Panel>
      ) : (
        <div className="two-col" style={{ gridTemplateColumns: "minmax(320px, 4fr) 8fr" }}>
          <Panel title="Connections">
            {connections.map((c) => (
              <div key={c.id} className="panel" style={{ background: "var(--bg-raised)", marginBottom: 10, borderColor: selectedId === c.id ? "var(--accent-dim)" : undefined }}>
                <div style={{ fontWeight: 650 }}>{c.name} {c.hasCredential && <span className="badge">auth</span>}</div>
                <div className="mono hint" style={{ margin: "4px 0" }}>{c.baseUrl}</div>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <StatusBadge status={c.connectionStatus} />
                  <div className="row">
                    <button className="btn btn-small" disabled={busy === c.id} onClick={() => test(c)}>{busy === c.id ? <Spinner /> : "Test"}</button>
                    <button className="btn btn-small" onClick={() => setSelectedId(c.id)}>Select</button>
                    <ConfirmButton label="Delete" onConfirm={async () => { await api.del(`/api/v1/opencode/connections/${c.id}`); refresh(); }} />
                  </div>
                </div>
                {c.lastError && <div className="hint" style={{ color: "var(--red)", marginTop: 4 }}>⚠ {c.lastError.slice(0, 140)}</div>}
              </div>
            ))}
          </Panel>

          <Panel title={selected ? `Sessions — ${selected.name}` : "Select a connection"} actions={<button className="btn btn-small" onClick={createSession} disabled={!selectedId}>+ New session</button>}>
            {!selectedId ? <div className="hint">Select a connection on the left.</div> : (
              <>
                {sessions === null ? <Spinner /> : sessions.length === 0 ? <div className="hint">No sessions, or server unreachable. Create one — it will appear on the OpenCode side immediately.</div> : (
                  <table className="table">
                    <thead><tr><th>Session</th><th>Title</th><th></th></tr></thead>
                    <tbody>
                      {sessions.map((s) => (
                        <tr key={s.id} style={{ background: sessionId === s.id ? "var(--bg-hover)" : undefined }}>
                          <td className="mono" style={{ fontSize: 10 }}>{s.id.slice(0, 16)}…</td>
                          <td>{s.title}</td>
                          <td><button className="btn btn-small" onClick={() => setSessionId(s.id)}>Select</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <hr className="divider" />
                <div className="panel-title">Send coding instruction</div>
                {!sessionId ? <div className="hint">Select or create a session.</div> : (
                  <>
                    <div className="hint" style={{ marginBottom: 6 }}>Session <span className="mono">{sessionId.slice(0, 16)}…</span> selected — destructive operations still require approval inside OpenCode's own permission flow.</div>
                    <textarea className="input textarea" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Implement X in the current project…" />
                    <div className="row" style={{ justifyContent: "space-between", marginTop: 8 }}>
                      <button className="btn btn-small btn-danger" onClick={async () => { try { await api.post(`/api/v1/opencode/connections/${selectedId}/sessions/${sessionId}/abort`, {}); show("Abort requested."); } catch (e) { show(errMessage(e), { error: true }); } }}>Abort session</button>
                      <button className="btn btn-primary" disabled={!prompt.trim() || busy === "prompt"} onClick={sendPrompt}>{busy === "prompt" ? <Spinner /> : "Send"}</button>
                    </div>
                    {promptResult && <ModelOutput content={promptResult} maxHeight={340} />}
                  </>
                )}
              </>
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}
