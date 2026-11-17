import { useEffect, useState } from "react";
import { api, errMessage } from "../api";
import { Panel, Spinner, Stat, useToastState } from "../components";

interface Summary {
  periodDays: number;
  requests: { total: number; succeeded: number; failed: number; avgLatencyMs: number | null };
  tokens: { prompt: number; completion: number; total: number; source: string };
  cost: { estimatedUsd: number | null; kind: string };
  agents: { total: number; running: number };
  workflows: { total: number; running: number };
  toolExecutions: { total: number };
}
interface ByModel { modelRowId: string | null; modelName: string | null; providerName: string | null; requests: number; totalTokens: number | null; estimatedCostUsd: number | null; avgLatencyMs: number | null }
interface ByProvider { providerId: string | null; providerName: string | null; requests: number; totalTokens: number | null; estimatedCostUsd: number | null }
interface RecentRequest { id: string; modelId: string; status: string; totalTokens: number | null; latencyMs: number | null; estimatedCostUsd: number | null; errorCode: string | null; createdAt: number }

export function Analytics() {
  const [days, setDays] = useState(30);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [byModel, setByModel] = useState<ByModel[]>([]);
  const [byProvider, setByProvider] = useState<ByProvider[]>([]);
  const [recent, setRecent] = useState<RecentRequest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { show, node } = useToastState();

  useEffect(() => {
    setSummary(null);
    api.get<Summary>(`/api/v1/analytics/summary?days=${days}`).then(setSummary).catch((e) => setError(errMessage(e)));
    api.get<{ models: ByModel[] }>(`/api/v1/analytics/by-model?days=${days}`).then((r) => setByModel(r.models)).catch(() => undefined);
    api.get<{ providers: ByProvider[] }>(`/api/v1/analytics/by-provider?days=${days}`).then((r) => setByProvider(r.providers)).catch(() => undefined);
    api.get<{ requests: RecentRequest[] }>("/api/v1/analytics/recent-requests?limit=15").then((r) => setRecent(r.requests)).catch(() => undefined);
  }, [days]);

  if (error) return <div className="page"><div className="panel">Failed to load analytics: {error} <button className="btn" onClick={() => setDays(30)}>Retry</button></div></div>;

  const barWidth = (value: number | null, max: number) => (max > 0 && value ? Math.max(2, (value / max) * 100) : 0);
  const maxModelTokens = Math.max(0, ...byModel.map((m) => Number(m.totalTokens ?? 0)));
  const maxProviderRequests = Math.max(0, ...byProvider.map((p) => p.requests));

  return (
    <div className="page">
      {node}
      <div className="page-header">
        <div>
          <div className="page-title">Analytics</div>
          <div className="page-sub">Measured telemetry only. Costs are estimates from your pricing configuration — never invoices; tokens are provider-reported.</div>
        </div>
        <select className="input" style={{ width: 160 }} value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {[7, 30, 90, 365].map((d) => <option key={d} value={d}>Last {d} days</option>)}
        </select>
      </div>

      {!summary ? <Spinner /> : (
        <>
          <div className="grid stats-grid">
            <Stat label="Requests" value={summary.requests.total} hint={`${summary.requests.succeeded} ok · ${summary.requests.failed} failed`} />
            <Stat label="Avg latency" value={summary.requests.avgLatencyMs != null ? `${summary.requests.avgLatencyMs} ms` : "—"} hint="provider-reported" />
            <Stat label="Tokens (total)" value={summary.tokens.total.toLocaleString()} hint={`prompt ${summary.tokens.prompt.toLocaleString()} / completion ${summary.tokens.completion.toLocaleString()}`} />
            <Stat label="Est. cost" value={summary.cost.estimatedUsd != null ? `$${summary.cost.estimatedUsd.toFixed(4)}` : "—"} hint="estimate only — not an invoice" />
            <Stat label="Agent runs" value={summary.agents.total} hint={`${summary.agents.running} running`} />
            <Stat label="Workflow runs" value={summary.workflows.total} hint={`${summary.workflows.running} running`} />
            <Stat label="Tool executions" value={summary.toolExecutions.total} />
            <Stat label="Error rate" value={summary.requests.total ? `${Math.round((summary.requests.failed / summary.requests.total) * 100)}%` : "—"} hint={`${summary.requests.failed} of ${summary.requests.total}`} />
          </div>

          <div className="two-col" style={{ marginTop: 14 }}>
            <Panel title="Token usage by model">
              {byModel.length === 0 ? <div className="hint">No usage recorded yet.</div> : byModel.map((m) => (
                <div key={m.modelRowId ?? Math.random()} style={{ marginBottom: 10 }}>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <span style={{ fontWeight: 600, fontSize: 12 }}>{m.modelName ?? m.modelRowId ?? "(unknown)"} <span className="hint">· {m.providerName ?? "—"}</span></span>
                    <span className="mono hint">{Number(m.totalTokens ?? 0).toLocaleString()} tok · {m.requests} req{m.estimatedCostUsd != null ? ` · $${Number(m.estimatedCostUsd).toFixed(4)} est` : ""}</span>
                  </div>
                  <div style={{ height: 6, background: "var(--bg-raised)", borderRadius: 3, marginTop: 3 }}>
                    <div style={{ height: "100%", width: `${barWidth(Number(m.totalTokens ?? 0), maxModelTokens)}%`, background: "var(--accent)", borderRadius: 3 }} />
                  </div>
                </div>
              ))}
            </Panel>

            <Panel title="Requests by provider">
              {byProvider.length === 0 ? <div className="hint">No usage recorded yet.</div> : byProvider.map((p) => (
                <div key={p.providerId ?? Math.random()} style={{ marginBottom: 10 }}>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <span style={{ fontWeight: 600, fontSize: 12 }}>{p.providerName ?? "(deleted provider)"}</span>
                    <span className="mono hint">{p.requests} req · {Number(p.totalTokens ?? 0).toLocaleString()} tok</span>
                  </div>
                  <div style={{ height: 6, background: "var(--bg-raised)", borderRadius: 3, marginTop: 3 }}>
                    <div style={{ height: "100%", width: `${barWidth(p.requests, maxProviderRequests)}%`, background: "var(--blue)", borderRadius: 3 }} />
                  </div>
                </div>
              ))}
            </Panel>
          </div>

          <Panel title="Recent requests" >
            {recent.length === 0 ? <div className="hint">Nothing yet. Every request you make appears here with measured telemetry.</div> : (
              <table className="table">
                <thead><tr><th>Time</th><th>Model</th><th>Status</th><th>Tokens</th><th>Latency</th><th>Est. cost</th></tr></thead>
                <tbody>
                  {recent.map((r) => (
                    <tr key={r.id}>
                      <td className="hint">{new Date(r.createdAt).toLocaleString()}</td>
                      <td className="mono">{r.modelId}</td>
                      <td>{r.status === "success" ? <span className="badge ok">success</span> : <span className="badge err" title={r.errorCode ?? ""}>error{r.errorCode ? ` · ${r.errorCode}` : ""}</span>}</td>
                      <td>{r.totalTokens ?? "—"}</td>
                      <td>{r.latencyMs != null ? `${r.latencyMs} ms` : "—"}</td>
                      <td>{r.estimatedCostUsd != null ? `$${r.estimatedCostUsd.toFixed(6)}` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}
