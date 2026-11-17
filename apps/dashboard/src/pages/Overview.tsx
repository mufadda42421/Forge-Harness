import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { ModelRow } from "./modelhub/ModelsTab";

interface OverviewData {
  providers: { total: number; connected: number; enabled: number };
  models: { total: number; enabled: number };
  agents: { total: number; enabled: number };
  executions: { runningWorkflows: number; awaitingApprovals: number };
  firstRun: boolean;
}

export function Overview() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [models, setModels] = useState<ModelRow[] | null>(null);
  const [modelId, setModelId] = useState<string>("");
  const [prompt, setPrompt] = useState("");
  const [filter, setFilter] = useState("");

  useEffect(() => {
    api.get<OverviewData>("/api/v1/overview").then(setData).catch(() => setData(null));
    api.get<{ models: ModelRow[] }>("/api/v1/models").then((r) => {
      const enabled = r.models.filter((m) => m.enabled);
      setModels(enabled);
      setModelId((cur) => cur || enabled[0]?.id || "");
    }).catch(() => undefined);
  }, []);

  const filteredModels = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = models ?? [];
    if (!q) return list;
    return list.filter((m) => `${m.displayName} ${m.modelId} ${m.providerName}`.toLowerCase().includes(q));
  }, [models, filter]);

  const selectedModel = models?.find((m) => m.id === modelId) ?? null;
  const firstRun = data?.firstRun ?? false;

  const launch = () => {
    const text = prompt.trim();
    if (!text) return;
    localStorage.setItem("forge.chat.pending", JSON.stringify({ prompt: text, modelId: modelId || undefined }));
    window.location.hash = "#/chat";
  };

  return (
    <div className="home-hero">
      <div className="home-mark">F</div>

      <h1 className="home-headline">
        Your infrastructure.<br />
        <span className="accent">Your rules.</span>
      </h1>
      <p className="home-sub">
        Bring any provider, any model, any key — then build, chat and orchestrate on top of them.
        Nothing is preloaded. Nothing leaves this machine except what you send.
      </p>

      <div className="composer" role="form" aria-label="New session composer">
        <textarea
          className="composer-input"
          autoFocus
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !e.shiftKey)) { e.preventDefault(); launch(); } }}
          placeholder="Describe what you want to build, / commands, @ files or sessions"
          aria-label="Prompt"
        />
        <div className="composer-bar">
          <button type="button" className="composer-icon-btn" title="Insert @ to reference files" onClick={() => setPrompt((p) => p + "@")}>+</button>
          <label className="model-chip" title="Choose the model this session will use">
            <span aria-hidden>◉</span>
            <select value={modelId} onChange={(e) => setModelId(e.target.value)} aria-label="Model">
              {models === null && <option value="">Loading models…</option>}
              {models !== null && models.length === 0 && <option value="">No models registered</option>}
              {filteredModels.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
            </select>
          </label>
          {models !== null && models.length > 12 && (
            <input
              className="input" style={{ width: 120, padding: "6px 10px", fontSize: 11 }}
              placeholder="filter…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              aria-label="Filter models"
            />
          )}
          <span className="home-chip byok" style={{ marginLeft: "auto" }}>BYOK</span>
          <button type="button" className="send-btn" onClick={launch} disabled={!prompt.trim()} aria-label="Start session">↑</button>
        </div>
      </div>

      <div className="home-chips">
        <span className="home-chip">Local-first</span>
        <span className="home-chip">Zero preloaded models</span>
        <span className="home-chip">AES-256-GCM keys</span>
      </div>

      {firstRun && (
        <a className="home-stat" style={{ color: "var(--accent)", borderColor: "var(--accent-dim)" }} href="#/model-hub?tab=providers">
          ◉ &nbsp;No providers yet — connect your first one to unlock inference →
        </a>
      )}

      {data && !firstRun && (
        <div className="home-stats">
          <a className="home-stat" href="#/model-hub">⬡ {data.models.enabled}/{data.models.total} models</a>
          <a className="home-stat" href="#/agents">⬢ {data.agents.enabled}/{data.agents.total} agents</a>
          <a className="home-stat" href="#/workflows">⤨ {data.executions.runningWorkflows} running</a>
          <a className="home-stat" href="#/analytics">∿ {data.executions.awaitingApprovals} awaiting approvals</a>
        </div>
      )}
    </div>
  );
}
