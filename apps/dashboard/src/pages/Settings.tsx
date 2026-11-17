import { useEffect, useState } from "react";
import { api, errMessage } from "../api";
import { Panel, Spinner, useToastState } from "../components";

export function Settings() {
  const [settings, setSettings] = useState<Record<string, unknown> | null>(null);
  const [key, setKey] = useState("toolPolicy.autoApproveReadOnly");
  const [value, setValue] = useState("true");
  const { show, node } = useToastState();

  const refresh = () => api.get<{ settings: Record<string, unknown> }>("/api/v1/settings").then((r) => setSettings(r.settings)).catch((e) => show(errMessage(e), { error: true }));
  useEffect(() => { refresh(); }, []);

  const save = async () => {
    let parsed: unknown = value;
    try { parsed = JSON.parse(value); } catch { /* treat as raw string */ }
    try {
      await api.put("/api/v1/settings", { [key]: parsed });
      show(`Saved ${key}.`);
      refresh();
    } catch (e) { show(errMessage(e), { error: true }); }
  };

  return (
    <div className="page">
      {node}
      <div className="page-header">
        <div>
          <div className="page-title">Settings</div>
          <div className="page-sub">Non-secret configuration only. Credentials belong to providers (Model Hub) or OpenCode connections — settings keys that look secret are rejected by design.</div>
        </div>
      </div>

      <Panel title="Environment">
        <dl className="kv">
          <dt>API binding</dt><dd className="mono">127.0.0.1:4789 (loopback). FORGE_HOST / FORGE_PORT to override; non-loopback requires FORGE_API_TOKEN.</dd>
          <dt>Data directory</dt><dd className="mono">~/.forge-harness (or FORGE_DATA_DIR) — SQLite database, encrypted credentials (AES-256-GCM), master.key</dd>
          <dt>Master key</dt><dd className="mono">FORGE_MASTER_KEY env var (base64, 32 bytes) for production; auto-generated master.key (0600) otherwise</dd>
          <dt>Database</dt><dd className="mono">SQLite via better-sqlite3 + Drizzle migrations — local, normalized, foreign keys enforced</dd>
          <dt>Credential store</dt><dd className="mono">API keys never stored in plaintext anywhere. OS keychain integration is pluggable via CredentialCipher; the default file-based provider is documented in README</dd>
          <dt>Telemetry</dt><dd>None. Forge Harness never phones home. Analytics are computed locally from your own usage rows.</dd>
        </dl>
      </Panel>

      <Panel title="Keys and values" actions={<button className="btn btn-primary" onClick={save}>Save</button>}>
        <div className="grid" style={{ gridTemplateColumns: "1fr 2fr", marginBottom: 12 }}>
          <div className="field"><label className="label">Key</label><input className="input mono" value={key} onChange={(e) => setKey(e.target.value)} /></div>
          <div className="field"><label className="label">Value (JSON or raw string)</label><input className="input mono" value={value} onChange={(e) => setValue(e.target.value)} /></div>
        </div>
        {settings === null ? <Spinner /> : Object.keys(settings).length === 0 ? (
          <div className="hint">No settings stored. Suggested keys: <code>toolPolicy.autoApproveReadOnly</code>, <code>toolPolicy.autoApproveAll</code>, <code>ui.compactMode</code>.</div>
        ) : (
          <table className="table">
            <thead><tr><th>Key</th><th>Value</th><th></th></tr></thead>
            <tbody>
              {Object.entries(settings).map(([k, v]) => (
                <tr key={k}>
                  <td className="mono">{k}</td>
                  <td className="mono" style={{ fontSize: 10.5 }}>{JSON.stringify(v)}</td>
                  <td><button className="btn btn-small" onClick={() => api.del(`/api/v1/settings/${encodeURIComponent(k)}`).then(refresh)}>Delete</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="Security posture">
        <ul style={{ paddingLeft: 18, color: "var(--text-dim)", lineHeight: 1.9 }}>
          <li>100% BYOK — no providers, models, keys or catalogs ship with this installation.</li>
          <li>Secrets are AES-256-GCM encrypted at rest, masked in the UI (last-4 hint), redacted from logs, never returned by the API, never placed in settings.</li>
          <li>SSRF guard allows loopback/private endpoints (local model servers are a first-class use case) but blocks cloud-metadata and link-local ranges.</li>
          <li>API binds to loopback by default; remote bind requires an explicit bearer token.</li>
          <li>Agents get zero tools until explicitly granted per agent; dangerous tools always require approval; approvals are recorded.</li>
          <li>Workflows must be acyclic (validated server-side); execution limits and retries are bounded; cancellation propagates.</li>
          <li>Fallback routing is never implicit — a model request always resolves to exactly the provider you registered.</li>
        </ul>
      </Panel>
    </div>
  );
}
