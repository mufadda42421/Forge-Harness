import { useEffect, useState } from "react";
import { api, errMessage } from "../api";
import { ConfirmButton, EmptyState, Panel, Spinner, useToastState } from "../components";
import type { ModelRow } from "./modelhub/ModelsTab";

interface Suite { id: string; name: string; description: string; caseCount: number }
interface Case { id: string; name: string; prompt: string; expectedSubstring: string | null; expectedRegex: string | null }
interface BenchmarkRun { id: string; suiteId: string; status: string; repeatCount: number; createdAt: number }
interface Aggregate {
  modelRowId: string; samples: number; successRate: number | null; errorCount: number;
  avgLatencyMs: number | null; medianLatencyMs: number | null; minLatencyMs: number | null; maxLatencyMs: number | null;
  totalTokens: number; estimatedCostUsd: number | null;
}

export function Benchmarks() {
  const [suites, setSuites] = useState<Suite[] | null>(null);
  const [selectedSuiteId, setSelectedSuiteId] = useState<string | null>(null);
  const [cases, setCases] = useState<Case[]>([]);
  const [models, setModels] = useState<ModelRow[]>([]);
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set());
  const [repeatCount, setRepeatCount] = useState(1);
  const [running, setRunning] = useState(false);
  const [aggregate, setAggregate] = useState<{ run: BenchmarkRun; aggregate: Aggregate[] } | null>(null);
  const [newSuite, setNewSuite] = useState({ name: "", description: "" });
  const [newCase, setNewCase] = useState({ name: "", prompt: "", expectedSubstring: "", expectedRegex: "" });
  const { show, node } = useToastState();

  const refreshSuites = () => api.get<{ suites: Suite[] }>("/api/v1/benchmarks/suites").then((r) => setSuites(r.suites)).catch((e) => show(errMessage(e), { error: true }));
  useEffect(() => { refreshSuites(); api.get<{ models: ModelRow[] }>("/api/v1/models").then((r) => setModels(r.models)).catch(() => undefined); }, []);
  useEffect(() => { if (selectedSuiteId) api.get<{ cases: Case[] }>(`/api/v1/benchmarks/suites/${selectedSuiteId}/cases`).then((r) => setCases(r.cases)); }, [selectedSuiteId]);

  const createSuite = async () => {
    try {
      const r = await api.post<{ suite: Suite }>("/api/v1/benchmarks/suites", newSuite);
      setNewSuite({ name: "", description: "" });
      refreshSuites();
      setSelectedSuiteId(r.suite.id);
    } catch (e) { show(errMessage(e), { error: true }); }
  };

  const createCase = async () => {
    if (!selectedSuiteId) return;
    try {
      await api.post(`/api/v1/benchmarks/suites/${selectedSuiteId}/cases`, {
        name: newCase.name,
        prompt: newCase.prompt,
        expectedSubstring: newCase.expectedSubstring || null,
        expectedRegex: newCase.expectedRegex || null,
      });
      setNewCase({ name: "", prompt: "", expectedSubstring: "", expectedRegex: "" });
      const r = await api.get<{ cases: Case[] }>(`/api/v1/benchmarks/suites/${selectedSuiteId}/cases`);
      setCases(r.cases);
      refreshSuites();
    } catch (e) { show(errMessage(e), { error: true }); }
  };

  const runBenchmark = async () => {
    if (!selectedSuiteId) return;
    setRunning(true);
    setAggregate(null);
    try {
      const summary = await api.post<{ runId: string; status: string; passed: number; failed: number; inconclusive: number }>(`/api/v1/benchmarks/suites/${selectedSuiteId}/run`, { modelRowIds: [...selectedModels], repeatCount });
      const detail = await api.get<{ run: BenchmarkRun; aggregate: Aggregate[] }>(`/api/v1/benchmarks/runs/${summary.runId}`);
      setAggregate(detail);
      show(`Run finished: ${summary.passed} passed, ${summary.failed} failed, ${summary.inconclusive} inconclusive.`);
    } catch (e) {
      show(errMessage(e), { error: true });
    } finally { setRunning(false); }
  };

  const modelName = (id: string) => models.find((m) => m.id === id)?.displayName ?? id;

  return (
    <div className="page">
      {node}
      <div className="page-header">
        <div>
          <div className="page-title">Benchmarks</div>
          <div className="page-sub">Deterministic, repeatable suites: substring/regex checks you define. Latency, tokens and cost (est.) are measured, never invented.</div>
        </div>
      </div>

      <div className="two-col" style={{ gridTemplateColumns: "minmax(300px, 4fr) 8fr" }}>
        <Panel title="Suites">
          <div className="row" style={{ marginBottom: 8 }}>
            <input className="input" placeholder="New suite name…" value={newSuite.name} onChange={(e) => setNewSuite({ ...newSuite, name: e.target.value })} />
            <button className="btn btn-primary" disabled={!newSuite.name.trim()} onClick={createSuite}>+ Add</button>
          </div>
          {suites === null ? <Spinner /> : suites.length === 0 ? (
            <EmptyState title="No benchmark suites" sub="Create a suite, add test cases with prompts and optional deterministic checks, then run it against your registered models." />
          ) : suites.map((s) => (
            <button key={s.id} className="btn" style={{ width: "100%", justifyContent: "space-between", marginBottom: 6, borderColor: selectedSuiteId === s.id ? "var(--accent-dim)" : undefined }} onClick={() => { setSelectedSuiteId(s.id); setAggregate(null); }}>
              <span>{s.name}</span>
              <span className="badge">{s.caseCount} cases</span>
            </button>
          ))}
        </Panel>

        <div>
          {selectedSuiteId && (
            <>
              <Panel title="Test cases" actions={<ConfirmButton label="Delete suite" onConfirm={async () => { await api.del(`/api/v1/benchmarks/suites/${selectedSuiteId}`); setSelectedSuiteId(null); refreshSuites(); }} />}>
                <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
                  <div className="field"><label className="label">Case name *</label><input className="input" value={newCase.name} onChange={(e) => setNewCase({ ...newCase, name: e.target.value })} placeholder="json-validity" /></div>
                  <div className="field"><label className="label">Expected substring (optional)</label><input className="input" value={newCase.expectedSubstring} onChange={(e) => setNewCase({ ...newCase, expectedSubstring: e.target.value })} placeholder="exact text that must appear" /></div>
                </div>
                <div className="field"><label className="label">Prompt *</label><textarea className="input textarea" style={{ minHeight: 60 }} value={newCase.prompt} onChange={(e) => setNewCase({ ...newCase, prompt: e.target.value })} placeholder="The exact prompt sent to each model…" /></div>
                 <div className="field"><label className="label">Expected regex (optional, overrides substring)</label><input className="input mono" value={newCase.expectedRegex} onChange={(e) => setNewCase({ ...newCase, expectedRegex: e.target.value })} placeholder="regex applied to the whole output" /></div>
                <button className="btn btn-primary" disabled={!newCase.name.trim() || !newCase.prompt.trim()} onClick={createCase}>+ Add case</button>
                {cases.length > 0 && (
                  <table className="table" style={{ marginTop: 10 }}>
                    <thead><tr><th>Case</th><th>Check</th><th></th></tr></thead>
                    <tbody>
                      {cases.map((c) => (
                        <tr key={c.id}>
                          <td>{c.name}</td>
                          <td className="mono" style={{ fontSize: 10 }}>{c.expectedRegex ? `regex: ${c.expectedRegex}` : c.expectedSubstring ? `substring: ${c.expectedSubstring}` : "none (informational)"}</td>
                          <td><ConfirmButton label="✕" className="btn btn-small btn-ghost" onConfirm={async () => { await api.del(`/api/v1/benchmarks/cases/${c.id}`); setCases(cases.filter((x) => x.id !== c.id)); refreshSuites(); }} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Panel>

              <Panel title="Run" >
                <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 8, marginBottom: 10 }}>
                  {models.filter((m) => m.enabled).map((m) => (
                    <label key={m.id} className="row" style={{ gap: 8, border: `1px solid ${selectedModels.has(m.id) ? "var(--accent-dim)" : "var(--border)"}`, borderRadius: 6, padding: "7px 9px", cursor: "pointer" }}>
                      <input className="checkbox" type="checkbox" checked={selectedModels.has(m.id)} onChange={() => { const n = new Set(selectedModels); n.has(m.id) ? n.delete(m.id) : n.add(m.id); setSelectedModels(n); }} />
                      <span style={{ fontSize: 12 }}>{m.displayName}</span>
                    </label>
                  ))}
                </div>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <label className="label">Repeat each case <input className="input" style={{ width: 70 }} type="number" min={1} max={10} value={repeatCount} onChange={(e) => setRepeatCount(Number(e.target.value))} /></label>
                  <button className="btn btn-primary" disabled={running || selectedModels.size === 0 || cases.length === 0} onClick={runBenchmark}>{running ? <><Spinner /> Running…</> : "Run benchmark"}</button>
                </div>
                {aggregate && (
                  <>
                    <hr className="divider" />
                    <div className="panel-title">Results ({aggregate.run.status})</div>
                    <table className="table">
                      <thead><tr><th>Model</th><th>Pass rate</th><th>Errors</th><th>Avg / median latency</th><th>Tokens</th><th>Est. cost</th></tr></thead>
                      <tbody>
                        {aggregate.aggregate.map((a) => (
                          <tr key={a.modelRowId}>
                            <td style={{ fontWeight: 600 }}>{modelName(a.modelRowId)}</td>
                            <td>{a.successRate != null ? `${Math.round(a.successRate * 100)}%` : "n/a (no checks)"}</td>
                            <td>{a.errorCount}</td>
                            <td>{a.avgLatencyMs != null ? `${a.avgLatencyMs} ms` : "—"} / {a.medianLatencyMs != null ? `${a.medianLatencyMs} ms` : "—"}</td>
                            <td>{a.totalTokens.toLocaleString()}</td>
                            <td>{a.estimatedCostUsd != null ? `$${a.estimatedCostUsd.toFixed(6)}` : "unpriced"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <a className="btn btn-small" style={{ marginTop: 8 }} href={`/api/v1/benchmarks/runs/${aggregate.run.id}/export`}>Export JSON</a>
                  </>
                )}
              </Panel>
            </>
          )}
          {!selectedSuiteId && <EmptyState title="Select or create a suite" sub="Suites group test cases and can be re-run any time against any subset of your registered models." />}
        </div>
      </div>
    </div>
  );
}
