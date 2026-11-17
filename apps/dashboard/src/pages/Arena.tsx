import { useEffect, useState } from "react";
import { api, errMessage } from "../api";
import { EmptyState, Panel, Spinner, useToastState } from '../components';
import { ModelOutput } from '../components/ModelOutput'; import { CodeBlock } from '../components/CodeBlock';
import type { ModelRow } from "./modelhub/ModelsTab";

interface ArenaResult {
  modelRowId: string;
  modelName: string;
  providerName: string | null;
  status: "success" | "error";
  content?: string;
  error?: string;
  usage: { promptTokens: number | null; completionTokens: number | null; totalTokens: number | null } | null;
  latencyMs: number | null;
  estimatedCostUsd: number | null;
}

export function Arena() {
  const [models, setModels] = useState<ModelRow[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [prompt, setPrompt] = useState("");
  const [temperature, setTemperature] = useState(0.7);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<ArenaResult[] | null>(null);
  const [judgeModelId, setJudgeModelId] = useState("");
  const [verdict, setVerdict] = useState<string | null>(null);
  const [judging, setJudging] = useState(false);
  const [scores, setScores] = useState<Record<string, number>>({});
  const { show, node } = useToastState();

  useEffect(() => {
    api.get<{ models: ModelRow[] }>("/api/v1/models").then((r) => setModels(r.models.filter((m) => m.enabled))).catch((e) => show(errMessage(e), { error: true }));
  }, []);

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  };

  const run = async () => {
    setRunning(true);
    setResults(null);
    setVerdict(null);
    try {
      const r = await api.post<{ results: ArenaResult[] }>("/api/v1/arena/run", {
        modelRowIds: [...selected],
        prompt,
        temperature,
      });
      setResults(r.results);
    } catch (e) {
      show(errMessage(e), { error: true });
    } finally {
      setRunning(false);
    }
  };

  const judge = async () => {
    if (!judgeModelId || !results) return;
    setJudging(true);
    try {
      const candidates = results.filter((r) => r.status === "success").map((r) => ({ modelName: r.modelName, content: r.content ?? "" }));
      if (candidates.length < 2) { show("Need at least two successful responses to judge.", { error: true }); return; }
      const r = await api.post<{ verdict: string }>("/api/v1/arena/judge", { judgeModelRowId: judgeModelId, prompt, candidates });
      setVerdict(r.verdict);
    } catch (e) {
      show(errMessage(e), { error: true });
    } finally {
      setJudging(false);
    }
  };

  const saveSession = async () => {
    if (!results) return;
    try {
      await api.post("/api/v1/arena/sessions", {
        prompt,
        config: { temperature, modelCount: selected.size },
        results,
      });
      show("Arena session saved.");
    } catch (e) { show(errMessage(e), { error: true }); }
  };

  return (
    <div className="page">
      {node}
      <div className="page-header">
        <div>
          <div className="page-title">Model Arena</div>
          <div className="page-sub">Same task → your models → side-by-side. Costs are your configured pricing estimates; quality scoring is manual or LLM-as-judge — never invented.</div>
        </div>
        {results && <div className="row"><button className="btn" onClick={saveSession}>Save session</button></div>}
      </div>

      {models === null ? <Spinner /> : models.length < 2 ? (
        <EmptyState title="Arena needs at least two registered models" sub="Register at least two models in the Model Hub first. Arena only compares models you configured — Forge Harness ships with none." action={<a className="btn btn-primary" href="#/model-hub">Go to Model Hub</a>} />
      ) : (
        <>
          <Panel title="1 · Select models">
            <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 8 }}>
              {models.map((m) => (
                <label key={m.id} className="row" style={{ gap: 8, border: `1px solid ${selected.has(m.id) ? "var(--accent-dim)" : "var(--border)"}`, borderRadius: 6, padding: "8px 10px", cursor: "pointer", background: selected.has(m.id) ? "rgba(232,179,75,.06)" : "transparent" }}>
                  <input className="checkbox" type="checkbox" checked={selected.has(m.id)} onChange={() => toggle(m.id)} />
                  <span><div style={{ fontWeight: 600 }}>{m.displayName}</div><div className="mono hint">{m.providerName}</div></span>
                </label>
              ))}
            </div>
          </Panel>

          <Panel title="2 · Prompt" actions={<div className="row"><label className="label" htmlFor="temp">temperature</label><input id="temp" className="input" style={{ width: 80 }} type="number" step="0.1" min={0} max={2} value={temperature} onChange={(e) => setTemperature(Number(e.target.value))} /></div>}>
            <textarea className="input textarea" style={{ minHeight: 90 }} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="The task all selected models will receive, verbatim…" />
            <div className="row" style={{ justifyContent: "flex-end", marginTop: 10 }}>
              <button className="btn btn-primary" disabled={selected.size < 2 || !prompt.trim() || running} onClick={run}>{running ? <><Spinner /> Running {selected.size} models…</> : `Run against ${selected.size} model(s)`}</button>
            </div>
          </Panel>

          {results && (
            <Panel title="3 · Results — side by side">
              <div className="grid" style={{ gridTemplateColumns: `repeat(${Math.min(results.length, 2)}, 1fr)` }}>
                {results.map((r) => (
                  <div key={r.modelRowId} className="panel" style={{ background: "var(--bg-raised)" }}>
                    <div className="row" style={{ justifyContent: "space-between" }}>
                      <div style={{ fontWeight: 650 }}>{r.modelName}{r.providerName && <span className="hint"> · {r.providerName}</span>}</div>
                      {r.status === "success"
                        ? <span className="badge ok">ok</span>
                        : <span className="badge err">error</span>}
                    </div>
                    <div className="mono hint" style={{ margin: "6px 0" }}>
                      latency: {r.latencyMs != null ? `${r.latencyMs} ms` : "—"} · tokens: {r.usage?.totalTokens ?? "—"} (p{r.usage?.promptTokens ?? "?"}/c{r.usage?.completionTokens ?? "?"}) · cost: {r.estimatedCostUsd != null ? `$${r.estimatedCostUsd.toFixed(6)} (est.)` : "unpriced"}
                    </div>
                    {r.status === "success" ? <ModelOutput content={r.content ?? ""} maxHeight={280} /> : <CodeBlock code={`Error: ${r.error}`} language="text" maxHeight={280} />}
                    <div className="field" style={{ marginTop: 8, marginBottom: 0 }}>
                      <label className="label">Manual quality score (0–10)</label>
                      <input className="input" style={{ width: 90 }} type="number" min={0} max={10} value={scores[r.modelRowId] ?? ""} onChange={(e) => setScores({ ...scores, [r.modelRowId]: Number(e.target.value) })} />
                    </div>
                  </div>
                ))}
              </div>

              <hr className="divider" />
              <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
                <div className="hint">LLM-as-judge is subjective and model-dependent. Prefer manual scoring; the judge is optional.</div>
                <div className="row">
                  <select className="input" style={{ maxWidth: 240 }} value={judgeModelId} onChange={(e) => setJudgeModelId(e.target.value)}>
                    <option value="">Select evaluator model…</option>
                    {models.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
                  </select>
                  <button className="btn" disabled={!judgeModelId || judging} onClick={judge}>{judging ? <Spinner /> : "Judge with LLM"}</button>
                </div>
              </div>
              {verdict && <><hr className="divider" /><div className="panel-title">Evaluator verdict (subjective)</div><ModelOutput content={verdict} maxHeight={300} /></>}
            </Panel>
          )}
        </>
      )}
    </div>
  );
}
