import { useEffect, useState } from "react";
import { api, errMessage } from "../api";
import { Panel, Spinner, StatusBadge, useToastState } from "../components";
import { ModelOutput } from "../components/ModelOutput";
import type { AgentRow } from "./Agents";

type Pattern = "sequential" | "parallel" | "hierarchical" | "evaluator" | "debate";

const PATTERN_INFO: Record<Pattern, { label: string; description: string; needsJudge: boolean }> = {
  sequential: { label: "Sequential", description: "Agent A → B → C. Each agent receives the previous output.", needsJudge: false },
  parallel: { label: "Parallel", description: "All agents work the same task independently; results are collated.", needsJudge: false },
  hierarchical: { label: "Hierarchical (Supervisor)", description: "Specialists execute in parallel; the supervisor synthesizes a final answer.", needsJudge: false },
  evaluator: { label: "Evaluator / Critic", description: "Producer generates; an evaluator judges; bounded revision loop (max 5 iterations).", needsJudge: true },
  debate: { label: "Debate", description: "Multiple debaters argue; a judge picks the strongest position.", needsJudge: true },
};

interface StepResult {
  agentId: string;
  agentName: string;
  output: string;
  status: string;
  error?: string;
  tokens: number | null;
  latencyMs: number;
}

export function Orchestrator() {
  const [agents, setAgents] = useState<AgentRow[] | null>(null);
  const [pattern, setPattern] = useState<Pattern>("sequential");
  const [input, setInput] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [judgeId, setJudgeId] = useState("");
  const [supervisorId, setSupervisorId] = useState("");
  const [maxIterations, setMaxIterations] = useState(2);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ executionId: string; status: string; output: string; steps: StepResult[]; totalTokens: number } | null>(null);
  const { show, node } = useToastState();

  useEffect(() => {
    api.get<{ agents: AgentRow[] }>("/api/v1/agents").then((r) => setAgents(r.agents)).catch((e) => show(errMessage(e), { error: true }));
  }, []);

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  };

  const info = PATTERN_INFO[pattern];
  const runnable = (agents ?? []).filter((a) => a.enabled);

  const run = async () => {
    setRunning(true);
    setResult(null);
    try {
      const steps = [...selected].map((agentId) => ({ agentId }));
      const r = await api.post<typeof result>("/api/v1/orchestrator/run", {
        pattern,
        input,
        steps,
        judgeAgentId: info.needsJudge ? judgeId || undefined : undefined,
        supervisorAgentId: pattern === "hierarchical" ? supervisorId || undefined : undefined,
        maxIterations,
      });
      setResult(r as never);
      show(`Orchestration ${r && (r as { status?: string }).status === "success" ? "completed" : "finished with failures"}.`);
    } catch (e) {
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
          <div className="page-title">Orchestrator</div>
          <div className="page-sub">Bounded multi-agent patterns. No unbounded recursion; every run is capped, ordered and cancellable.</div>
        </div>
      </div>

      <Panel title="1 · Pattern">
        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))", gap: 8 }}>
          {(Object.entries(PATTERN_INFO) as [Pattern, typeof PATTERN_INFO[Pattern]][]).map(([key, info]) => (
            <button key={key} className="btn" onClick={() => setPattern(key)} style={{ textAlign: "left", padding: "10px 12px", borderColor: pattern === key ? "var(--accent-dim)" : undefined, background: pattern === key ? "rgba(232,179,75,.07)" : undefined }}>
              <div style={{ fontWeight: 650, color: pattern === key ? "var(--accent)" : undefined }}>{info.label}</div>
              <div className="hint" style={{ marginTop: 4 }}>{info.description}</div>
            </button>
          ))}
        </div>
      </Panel>

      <Panel title="2 · Agents">
        {agents === null ? <Spinner /> : runnable.length === 0 ? (
          <div className="hint">No enabled agents. Create agents in the Agents page first — orchestration runs them, it doesn't replace them.</div>
        ) : (
          <>
            <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 8 }}>
              {runnable.map((a) => (
                <label key={a.id} className="row" style={{ gap: 8, border: `1px solid ${selected.has(a.id) ? "var(--accent-dim)" : "var(--border)"}`, borderRadius: 6, padding: "8px 10px", cursor: "pointer" }}>
                  <input className="checkbox" type="checkbox" checked={selected.has(a.id)} onChange={() => toggle(a.id)} />
                  <span><div style={{ fontWeight: 600 }}>{a.name}</div><div className="mono hint">{a.modelId ? "model assigned" : "unassigned"}</div></span>
                </label>
              ))}
            </div>
            <div className="grid" style={{ gridTemplateColumns: "1fr 1fr 1fr", marginTop: 12 }}>
              {info.needsJudge && (
                <div className="field"><label className="label">Judge / evaluator agent *</label>
                  <select className="input" value={judgeId} onChange={(e) => setJudgeId(e.target.value)}>
                    <option value="">Select judge…</option>
                    {runnable.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </div>
              )}
              {pattern === "hierarchical" && (
                <div className="field"><label className="label">Supervisor (defaults to first selected)</label>
                  <select className="input" value={supervisorId} onChange={(e) => setSupervisorId(e.target.value)}>
                    <option value="">— first selected —</option>
                    {runnable.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </div>
              )}
              {pattern === "evaluator" && (
                <div className="field"><label className="label">Max revision iterations (≤5)</label><input className="input" type="number" min={1} max={5} value={maxIterations} onChange={(e) => setMaxIterations(Number(e.target.value))} /></div>
              )}
            </div>
          </>
        )}
      </Panel>

      <Panel title="3 · Task">
        <textarea className="input textarea" style={{ minHeight: 80 }} value={input} onChange={(e) => setInput(e.target.value)} placeholder="The task to orchestrate across the selected agents…" />
        <div className="row" style={{ justifyContent: "flex-end", marginTop: 10 }}>
          <button className="btn btn-primary" disabled={running || selected.size === 0 || !input.trim() || (info.needsJudge && !judgeId)} onClick={run}>{running ? <><Spinner /> Orchestrating…</> : "Run Orchestration"}</button>
        </div>
      </Panel>

      {result && (
        <Panel title="Result">
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
            <StatusBadge status={result.status} />
            <span className="hint">execution {result.executionId} · {result.totalTokens} tokens</span>
          </div>
          {result.steps.map((s, i) => (
            <div key={i} className="panel" style={{ background: "var(--bg-raised)", marginBottom: 8 }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <div style={{ fontWeight: 600 }}>{i + 1}. {s.agentName}{s.error && <span className="hint" style={{ color: "var(--red)" }}> — {s.error.slice(0, 160)}</span>}</div>
                <span className="mono hint">{s.latencyMs} ms · {s.tokens ?? "?"} tok</span>
              </div>
              <ModelOutput content={s.output || "(no output)"} maxHeight={220} />
            </div>
          ))}
          {result.output && <><hr className="divider" /><div className="panel-title">Final output</div><ModelOutput content={result.output} maxHeight={420} /></>}
        </Panel>
      )}
    </div>
  );
}
