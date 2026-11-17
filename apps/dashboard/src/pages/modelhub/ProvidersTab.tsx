import { useEffect, useState } from "react";
import { api, errMessage } from "../../api";
import { ConfirmButton, Panel, StatusBadge, Spinner, useToastState } from "../../components";

export interface ProviderRow {
  id: string;
  name: string;
  identifier: string;
  baseUrl: string;
  compatibility: string;
  authMethod: string;
  customHeaders: Record<string, string>;
  timeoutMs: number;
  maxRetries: number;
  enabled: boolean;
  connectionStatus: string;
  lastTestedAt: number | null;
  lastError: string | null;
  hasCredential: boolean;
  keyHint: string | null;
  createdAt: number;
}

const COMPATIBILITY_INFO: Record<string, { label: string; hint: string; defaultUrl: string }> = {
  openai: { label: "OpenAI-compatible", hint: "Any endpoint speaking the OpenAI chat-completions dialect (OpenAI, vLLM, LM Studio, DeepSeek, Mistral…).", defaultUrl: "https://api.openai.com/v1" },
  anthropic: { label: "Anthropic-compatible", hint: "Anthropic Messages API (api.anthropic.com style gateways included).", defaultUrl: "https://api.anthropic.com" },
  google: { label: "Google Gemini", hint: "Google Generative Language API (generativelanguage.googleapis.com).", defaultUrl: "https://generativelanguage.googleapis.com" },
  ollama: { label: "Ollama", hint: "Local Ollama server (native /api/chat + /api/tags discovery).", defaultUrl: "http://127.0.0.1:11434" },
  openrouter: { label: "OpenRouter", hint: "OpenRouter. Use your OpenRouter key; model IDs are the ones OpenRouter routes.", defaultUrl: "https://openrouter.ai/api/v1" },
  "custom-http": { label: "Custom HTTP", hint: "Any HTTP endpoint speaking the OpenAI chat-completions dialect. Configure auth headers yourself.", defaultUrl: "" },
};

export function ProvidersTab() {
  const [providers, setProviders] = useState<ProviderRow[] | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const { show, node } = useToastState();

  const refresh = () => api.get<{ providers: ProviderRow[] }>("/api/v1/providers").then((r) => setProviders(r.providers)).catch((e) => show(errMessage(e), { error: true }));
  useEffect(() => { refresh(); }, []);

  const [form, setForm] = useState({
    name: "",
    identifier: "",
    baseUrl: "",
    compatibility: "openai",
    authMethod: "bearer",
    apiKey: "",
    customHeaders: "",
    timeoutMs: 60000,
    maxRetries: 2,
  });

  const submit = async () => {
    setBusy("create");
    try {
      let customHeaders: Record<string, string> | undefined;
      if (form.customHeaders.trim()) {
        customHeaders = JSON.parse(form.customHeaders) as Record<string, string>;
      }
      await api.post("/api/v1/providers", {
        name: form.name,
        identifier: form.identifier,
        baseUrl: form.baseUrl,
        compatibility: form.compatibility,
        authMethod: form.authMethod,
        apiKey: form.apiKey || undefined,
        customHeaders,
        timeoutMs: Number(form.timeoutMs),
        maxRetries: Number(form.maxRetries),
      });
      show(`Provider "${form.name}" registered. No connection test has been run yet.`);
      setShowForm(false);
      setForm({ ...form, name: "", identifier: "", baseUrl: "", apiKey: "", customHeaders: "" });
      refresh();
    } catch (e) {
      show(errMessage(e), { error: true });
    } finally {
      setBusy(null);
    }
  };

  const testProvider = async (p: ProviderRow) => {
    setBusy(p.id);
    try {
      const result = await api.post<{ ok: boolean; latencyMs?: number; detail?: string; error?: { message: string } }>(`/api/v1/providers/${p.id}/test`, {});
      if (result.ok) show(`✓ ${p.name}: reachable in ${result.latencyMs} ms — ${result.detail ?? ""}`);
      else show(`✗ ${p.name}: ${result.error?.message ?? "connection failed"}`, { error: true });
      refresh();
    } catch (e) {
      show(errMessage(e), { error: true });
      refresh();
    } finally {
      setBusy(null);
    }
  };

  const discoverImport = async (p: ProviderRow) => {
    setBusy(p.id);
    try {
      const result = await api.post<{ imported: string[]; skipped: number }>(`/api/v1/providers/${p.id}/discover/import`, {});
      show(`Imported ${result.imported.length} model(s) from ${p.name} (${result.skipped} already registered).`);
      refresh();
    } catch (e) {
      show(errMessage(e), { error: true });
    } finally {
      setBusy(null);
    }
  };

  const rotateKey = async (p: ProviderRow) => {
    const value = window.prompt(`New API key for ${p.name}. It will be encrypted locally and never shown again.`);
    if (!value) return;
    try {
      await api.post(`/api/v1/providers/${p.id}/apikey`, { apiKey: value });
      show("Credential rotated. The old key is deleted.");
      refresh();
    } catch (e) {
      show(errMessage(e), { error: true });
    }
  };

  const toggle = async (p: ProviderRow) => {
    try {
      await api.patch(`/api/v1/providers/${p.id}`, { enabled: !p.enabled });
      refresh();
    } catch (e) {
      show(errMessage(e), { error: true });
    }
  };

  const remove = async (p: ProviderRow) => {
    try {
      await api.del(`/api/v1/providers/${p.id}`);
      show(`Provider "${p.name}" deleted, along with its stored credentials.`);
      refresh();
    } catch (e) {
      show(errMessage(e), { error: true });
    }
  };

  return (
    <div>
      {node}
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
        <div className="hint">Providers are user-registered. API keys are encrypted at rest (AES-256-GCM) and never leave this machine except to the endpoint you configured.</div>
        <button className="btn btn-primary" onClick={() => setShowForm((v) => !v)}>{showForm ? "Close" : "+ Connect Provider"}</button>
      </div>

      {showForm && (
        <Panel title="Register a provider" actions={<span className="badge info">BYOK</span>}>
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <div className="field"><label className="label">Display name *</label><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="My OpenAI Account" /></div>
            <div className="field"><label className="label">Identifier * (slug)</label><input className="input mono" value={form.identifier} onChange={(e) => setForm({ ...form, identifier: e.target.value })} placeholder="my-openai" /></div>
          </div>
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <div className="field">
              <label className="label">Compatibility *</label>
              <select className="input" value={form.compatibility} onChange={(e) => {
                const compat = e.target.value;
                const info = COMPATIBILITY_INFO[compat];
                setForm({ ...form, compatibility: compat, baseUrl: info?.defaultUrl ?? "" });
              }}>
                {Object.entries(COMPATIBILITY_INFO).map(([key, info]) => <option key={key} value={key}>{info.label}</option>)}
              </select>
              <div className="hint">{COMPATIBILITY_INFO[form.compatibility]?.hint}</div>
            </div>
            <div className="field">
              <label className="label">Base URL *</label>
              <input className="input mono" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder={COMPATIBILITY_INFO[form.compatibility]?.defaultUrl} />
            </div>
          </div>
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
            <div className="field">
              <label className="label">Auth method</label>
              <select className="input" value={form.authMethod} onChange={(e) => setForm({ ...form, authMethod: e.target.value })}>
                <option value="bearer">Bearer token</option>
                <option value="x-api-key">x-api-key header</option>
                <option value="x-goog-api-key">x-goog-api-key header</option>
                <option value="none">None (local, e.g. Ollama)</option>
                <option value="custom">Custom headers only</option>
              </select>
            </div>
            <div className="field"><label className="label">Timeout (ms)</label><input className="input" type="number" value={form.timeoutMs} onChange={(e) => setForm({ ...form, timeoutMs: Number(e.target.value) })} /></div>
            <div className="field"><label className="label">Max retries</label><input className="input" type="number" min={0} max={5} value={form.maxRetries} onChange={(e) => setForm({ ...form, maxRetries: Number(e.target.value) })} /></div>
          </div>
          <div className="field"><label className="label">API key {form.authMethod === "none" && "(not required)"}</label>
            <input className="input mono" type="password" autoComplete="off" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} placeholder="sk-… — encrypted locally, never displayed again" />
          </div>
          <div className="field"><label className="label">Custom headers (JSON, optional)</label>
            <textarea className="input textarea" value={form.customHeaders} onChange={(e) => setForm({ ...form, customHeaders: e.target.value })} placeholder={'{"HTTP-Referer": "https://myapp.example"}'} />
            <div className="hint">Header values are stored locally with your provider config but are redacted in all UI and API responses.</div>
          </div>
          <div className="row" style={{ justifyContent: "flex-end", marginTop: 4 }}>
            <button className="btn" onClick={() => setShowForm(false)}>Cancel</button>
            <button className="btn btn-primary" disabled={!!busy || !form.name || !form.identifier || !form.baseUrl} onClick={submit}>{busy === "create" ? <Spinner /> : "Register Provider"}</button>
          </div>
        </Panel>
      )}

      {providers === null ? <Spinner /> : providers.length === 0 ? (
        <div className="empty" style={{ marginTop: 12 }}>
          <div className="empty-icon">⬡</div>
          <div className="empty-title">No providers configured</div>
          <div className="empty-sub">Forge Harness ships with zero providers. Register your own — OpenAI, Anthropic, Gemini, OpenRouter, Ollama, or any compatible endpoint — and keep your keys on your machine.</div>
          <button className="btn btn-primary" onClick={() => setShowForm(true)}>Connect Your First Provider</button>
        </div>
      ) : (
        <Panel title={`Providers (${providers.length})`}>
          <table className="table">
            <thead><tr><th>Provider</th><th>Compat</th><th>Status</th><th>Credential</th><th>Enabled</th><th style={{ textAlign: "right" }}>Actions</th></tr></thead>
            <tbody>
              {providers.map((p) => (
                <tr key={p.id}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{p.name}</div>
                    <div className="mono hint">{p.identifier} · {p.baseUrl}</div>
                    {p.lastError && <div className="hint" style={{ color: "var(--red)" }}>⚠ {p.lastError.slice(0, 120)}</div>}
                  </td>
                  <td><span className="badge info">{COMPATIBILITY_INFO[p.compatibility]?.label ?? p.compatibility}</span></td>
                  <td><StatusBadge status={p.connectionStatus} />{p.lastTestedAt && <div className="hint">tested {new Date(p.lastTestedAt).toLocaleString()}</div>}</td>
                  <td>{p.hasCredential ? <span className="mono">{p.keyHint}</span> : <span className="badge err">missing</span>}</td>
                  <td><label className="row" style={{ gap: 4 }}><input className="checkbox" type="checkbox" checked={p.enabled} onChange={() => toggle(p)} /></label></td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <button className="btn btn-small" disabled={busy === p.id} onClick={() => testProvider(p)}>{busy === p.id ? <Spinner /> : "Test"}</button>{" "}
                    <button className="btn btn-small" disabled={busy === p.id} onClick={() => discoverImport(p)}>Discover…</button>{" "}
                    <button className="btn btn-small" onClick={() => rotateKey(p)}>Rotate key</button>{" "}
                    <ConfirmButton label="Delete" onConfirm={() => remove(p)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
    </div>
  );
}
