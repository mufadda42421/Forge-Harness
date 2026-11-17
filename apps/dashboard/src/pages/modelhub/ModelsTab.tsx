import { useEffect, useState } from "react";
import { api, errMessage } from "../../api";
import { ConfirmButton, Panel, Spinner, useToastState } from "../../components";
import type { ProviderRow } from "./ProvidersTab";

export interface ModelRow {
  id: string;
  providerId: string;
  providerName: string;
  modelId: string;
  displayName: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  inputCostPer1M: number | null;
  outputCostPer1M: number | null;
  costConfigured: boolean;
  supportsStreaming: boolean | null;
  supportsTools: boolean | null;
  supportsVision: boolean | null;
  enabled: boolean;
  source: string;
  capabilities: Record<string, string>;
  createdAt: number;
}

const CAPABILITIES = ["text", "reasoning", "tool_calling", "structured_output", "vision", "image_generation", "audio_input", "audio_output", "embeddings"] as const;

export function ModelsTab({ providerCount }: { providerCount: number }) {
  const [models, setModels] = useState<ModelRow[] | null>(null);
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const { show, node } = useToastState();

  const [form, setForm] = useState({
    providerId: "",
    modelId: "",
    displayName: "",
    contextWindow: "",
    maxOutputTokens: "",
    inputCostPer1M: "",
    outputCostPer1M: "",
  });
  const [capForm, setCapForm] = useState<Record<string, string>>({});

  const refresh = () => {
    api.get<{ models: ModelRow[] }>("/api/v1/models").then((r) => setModels(r.models)).catch((e) => show(errMessage(e), { error: true }));
    api.get<{ providers: ProviderRow[] }>("/api/v1/providers").then((r) => {
      setProviders(r.providers);
      if (!form.providerId && r.providers[0]) setForm((f) => ({ ...f, providerId: r.providers[0]!.id }));
    }).catch(() => undefined);
  };
  useEffect(() => { refresh(); }, []);

  const submit = async () => {
    setBusy("create");
    try {
      const caps: Record<string, string> = {};
      for (const [k, v] of Object.entries(capForm)) if (v && v !== "unset") caps[k] = v;
      await api.post("/api/v1/models", {
        providerId: form.providerId,
        modelId: form.modelId,
        displayName: form.displayName || form.modelId,
        contextWindow: form.contextWindow ? Number(form.contextWindow) : null,
        maxOutputTokens: form.maxOutputTokens ? Number(form.maxOutputTokens) : null,
        inputCostPer1M: form.inputCostPer1M ? Number(form.inputCostPer1M) : null,
        outputCostPer1M: form.outputCostPer1M ? Number(form.outputCostPer1M) : null,
        capabilities: caps,
      });
      show(`Model "${form.modelId}" registered on ${providers.find((p) => p.id === form.providerId)?.name}.`);
      setShowForm(false);
      setForm({ ...form, modelId: "", displayName: "", contextWindow: "", maxOutputTokens: "", inputCostPer1M: "", outputCostPer1M: "" });
      setCapForm({});
      refresh();
    } catch (e) {
      show(errMessage(e), { error: true });
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (m: ModelRow) => {
    try {
      await api.patch(`/api/v1/models/${m.id}`, { enabled: !m.enabled });
      refresh();
    } catch (e) {
      show(errMessage(e), { error: true });
    }
  };

  const remove = async (m: ModelRow) => {
    try {
      await api.del(`/api/v1/models/${m.id}`);
      show(`Model "${m.displayName}" removed.`);
      refresh();
    } catch (e) {
      show(errMessage(e), { error: true });
    }
  };

  const exportModels = async () => {
    const data = await api.get<unknown>("/api/v1/models/export");
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "forge-models-export.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  const filtered = (models ?? []).filter((m) => !search || `${m.displayName} ${m.modelId} ${m.providerName}`.toLowerCase().includes(search.toLowerCase()));

  return (
    <div>
      {node}
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
        <input className="input" style={{ maxWidth: 320 }} placeholder="Search models…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="row">
          <button className="btn" onClick={exportModels}>Export JSON</button>
          <button className="btn btn-primary" onClick={() => setShowForm((v) => !v)}>+ Register Model</button>
        </div>
      </div>

      {showForm && (
        <Panel title="Register a model manually" actions={<span className="badge warn">unknown pricing = no cost estimates</span>}>
          {providerCount === 0 ? (
            <div className="hint">No providers exist yet. Add a provider first (Providers tab) — models belong to providers.</div>
          ) : (
            <>
              <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
                <div className="field"><label className="label">Provider *</label>
                  <select className="input" value={form.providerId} onChange={(e) => setForm({ ...form, providerId: e.target.value })}>
                    {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
                <div className="field"><label className="label">Model identifier * (as sent to provider)</label><input className="input mono" value={form.modelId} onChange={(e) => setForm({ ...form, modelId: e.target.value })} placeholder="my-model-7b-instruct" /></div>
              </div>
              <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
                <div className="field"><label className="label">Display name</label><input className="input" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} placeholder="defaults to identifier" /></div>
                <div className="field"><label className="label">Context window (tokens)</label><input className="input" type="number" value={form.contextWindow} onChange={(e) => setForm({ ...form, contextWindow: e.target.value })} placeholder="leave empty if unknown" /></div>
              </div>
              <div className="grid" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
                <div className="field"><label className="label">Max output tokens</label><input className="input" type="number" value={form.maxOutputTokens} onChange={(e) => setForm({ ...form, maxOutputTokens: e.target.value })} /></div>
                <div className="field"><label className="label">Input $ / 1M tokens</label><input className="input" type="number" step="0.01" value={form.inputCostPer1M} onChange={(e) => setForm({ ...form, inputCostPer1M: e.target.value })} placeholder="unknown" /></div>
                <div className="field"><label className="label">Output $ / 1M tokens</label><input className="input" type="number" step="0.01" value={form.outputCostPer1M} onChange={(e) => setForm({ ...form, outputCostPer1M: e.target.value })} placeholder="unknown" /></div>
              </div>
              <div className="field">
                <label className="label">Capabilities (default: unknown — never assumed)</label>
                <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 8 }}>
                  {CAPABILITIES.map((cap) => (
                    <label key={cap} className="row" style={{ gap: 6, fontSize: 11 }}>
                      <span className="mono" style={{ minWidth: 118, color: "var(--text-dim)" }}>{cap}</span>
                      <select className="input" style={{ padding: "3px 6px", fontSize: 11 }} value={capForm[cap] ?? "unset"} onChange={(e) => setCapForm({ ...capForm, [cap]: e.target.value })}>
                        <option value="unset">unknown</option>
                        <option value="supported">supported</option>
                        <option value="unsupported">unsupported</option>
                      </select>
                    </label>
                  ))}
                </div>
              </div>
              <div className="row" style={{ justifyContent: "flex-end" }}>
                <button className="btn" onClick={() => setShowForm(false)}>Cancel</button>
                <button className="btn btn-primary" disabled={!!busy || !form.modelId || !form.providerId} onClick={submit}>{busy === "create" ? <Spinner /> : "Register Model"}</button>
              </div>
            </>
          )}
        </Panel>
      )}

      {models === null ? <Spinner /> : filtered.length === 0 ? (
        <div className="empty" style={{ marginTop: 12 }}>
          <div className="empty-icon">⬡</div>
          <div className="empty-title">{models.length === 0 ? "No models registered" : "No models match your search"}</div>
          <div className="empty-sub">{models.length === 0 ? "Models appear only after you register them — manually, or by discovery from a provider that supports it. Forge Harness ships with none." : "Try a different search."}</div>
        </div>
      ) : (
        <Panel title={`Registered models (${filtered.length})`}>
          <table className="table">
            <thead><tr><th>Model</th><th>Provider</th><th>Context</th><th>Pricing ($/1M)</th><th>Capabilities</th><th>Enabled</th><th style={{ textAlign: "right" }}>Actions</th></tr></thead>
            <tbody>
              {filtered.map((m) => {
                const supported = Object.entries(m.capabilities).filter(([, v]) => v === "supported").map(([k]) => k);
                return (
                  <tr key={m.id}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{m.displayName}</div>
                      <div className="mono hint">{m.modelId} · via {m.source}</div>
                    </td>
                    <td>{m.providerName}</td>
                    <td>{m.contextWindow?.toLocaleString() ?? "unknown"}</td>
                    <td className="mono">{m.costConfigured ? `${m.inputCostPer1M} / ${m.outputCostPer1M}` : <span className="badge unknown">unconfigured</span>}</td>
                    <td><div className="row" style={{ flexWrap: "wrap", gap: 3 }}>{supported.length === 0 ? <span className="hint">none detected</span> : supported.slice(0, 3).map((c) => <span key={c} className="badge ok">{c}</span>)}{supported.length > 3 && <span className="hint">+{supported.length - 3}</span>}</div></td>
                    <td><input className="checkbox" type="checkbox" checked={m.enabled} onChange={() => toggle(m)} /></td>
                    <td style={{ textAlign: "right" }}><ConfirmButton label="Delete" onConfirm={() => remove(m)} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Panel>
      )}
    </div>
  );
}
