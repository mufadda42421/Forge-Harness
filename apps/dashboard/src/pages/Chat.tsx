import { useEffect, useMemo, useRef, useState } from "react";
import { api, errMessage } from "../api";
import { EmptyState, Panel, Spinner, useToastState } from "../components";
import { ModelOutput } from "../components/ModelOutput";
import type { ModelRow } from "./modelhub/ModelsTab";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  tokens?: number | null;
  costUsd?: number | null;
}

const STORAGE_MESSAGES = "forge.chat.messages";
const STORAGE_MODEL = "forge.chat.model";

function loadMessages(): ChatMessage[] {
  try {
    const raw = localStorage.getItem(STORAGE_MESSAGES);
    const parsed = raw ? JSON.parse(raw) as unknown : [];
    return Array.isArray(parsed) ? (parsed as ChatMessage[]) : [];
  } catch {
    return [];
  }
}

export function Chat() {
  const [models, setModels] = useState<ModelRow[] | null>(null);
  const [modelId, setModelId] = useState<string>(() => localStorage.getItem(STORAGE_MODEL) ?? "");
  const [modelFilter, setModelFilter] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>(loadMessages);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [liveTokens, setLiveTokens] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { show, node } = useToastState();

  useEffect(() => {
    api.get<{ models: ModelRow[] }>("/api/v1/models").then((r) => {
      const enabled = r.models.filter((m) => m.enabled);
      setModels(enabled);
      // Consume a pending prompt handed over from the home composer.
      let pending: { prompt?: string; modelId?: string } | null = null;
      try {
        const raw = localStorage.getItem("forge.chat.pending");
        if (raw) {
          pending = JSON.parse(raw) as { prompt?: string; modelId?: string };
          localStorage.removeItem("forge.chat.pending");
        }
      } catch {
        localStorage.removeItem("forge.chat.pending");
      }
      const chosen = pending?.modelId ? enabled.find((m) => m.id === pending.modelId) : undefined;
      if (pending?.prompt && (chosen ?? enabled[0])) {
        setModelId((chosen ?? enabled[0])!.id);
        void doSend(pending.prompt, (chosen ?? enabled[0])!);
      } else if (!modelId && enabled[0]) {
        setModelId(enabled[0].id);
      }
    }).catch((e) => show(errMessage(e), { error: true }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_MESSAGES, JSON.stringify(messages));
    localStorage.setItem(STORAGE_MODEL, modelId);
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, modelId]);

  const filteredModels = useMemo(() => {
    const q = modelFilter.trim().toLowerCase();
    if (!q) return models ?? [];
    return (models ?? []).filter((m) => `${m.displayName} ${m.modelId} ${m.providerName}`.toLowerCase().includes(q));
  }, [models, modelFilter]);

  const selectedModel = useMemo(() => (models ?? []).find((m) => m.id === modelId) ?? null, [models, modelId]);

  // Keep the selection visible in the filtered list: if it drops out of the
  // filter, jump to the first match.
  useEffect(() => {
    if (modelFilter.trim() && filteredModels.length > 0 && !filteredModels.some((m) => m.id === modelId)) {
      setModelId(filteredModels[0]!.id);
    }
  }, [filteredModels, modelFilter, modelId]);

  const clear = () => {
    abortRef.current?.abort();
    setMessages([]);
    setLiveTokens(null);
  };

  const stop = () => abortRef.current?.abort();

  const doSend = async (rawText: string, model: ModelRow) => {
    const text = rawText.trim();
    if (!text || streaming) return;
    const userMsg: ChatMessage = { id: crypto.randomUUID(), role: "user", content: text };
    const assistantMsg: ChatMessage = { id: crypto.randomUUID(), role: "assistant", content: "" };
    const next = [...messages, userMsg, assistantMsg];
    setMessages(next);
    setInput("");
    setStreaming(true);
    setLiveTokens(null);

    const history = next.slice(0, -1).map((m) => ({ role: m.role, content: m.content }));
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await fetch("/api/v1/router/chat/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ modelRowId: model.id, messages: history }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let eventName = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const lines = frame.split("\n");
          let dataStr = "";
          eventName = "";
          for (const line of lines) {
            if (line.startsWith("event:")) eventName = line.slice(6).trim();
            else if (line.startsWith("data:")) dataStr += line.slice(5).trim();
          }
          if (!dataStr) continue;
          let data: { text?: string; message?: string; code?: string; usage?: { totalTokens?: number | null }; estimatedCostUsd?: number | null };
          try { data = JSON.parse(dataStr); } catch { continue; }
          if (eventName === "delta" && data.text) {
            const chunk = data.text;
            setMessages((prev) => prev.map((m) => (m.id === assistantMsg.id ? { ...m, content: m.content + chunk } : m)));
          } else if (eventName === "usage" && data.usage) {
            setLiveTokens(data.usage.totalTokens ?? null);
          } else if (eventName === "done") {
            const total = data.usage?.totalTokens ?? null;
            setLiveTokens(total);
            setMessages((prev) => prev.map((m) => (m.id === assistantMsg.id ? { ...m, tokens: total, costUsd: data.estimatedCostUsd ?? null } : m)));
          } else if (eventName === "error") {
            throw new Error(`${data.code ?? "ERROR"}: ${data.message ?? "provider error"}`);
          }
        }
      }
    } catch (err) {
      if (ac.signal.aborted) {
        setMessages((prev) => prev.map((m) => (m.id === assistantMsg.id && !m.content ? { ...m, content: "_stopped_" } : m)));
      } else {
        const message = errMessage(err);
        setMessages((prev) => prev.map((m) => (m.id === assistantMsg.id ? { ...m, content: `Error: ${message}` } : m)));
        show(message, { error: true });
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  };

  const send = async () => {
    if (selectedModel) await doSend(input, selectedModel);
  };

  if (models === null) return <div className="page"><Spinner /></div>;

  if (models.length === 0) {
    return (
      <div className="page">
        <div className="page-header"><div><div className="page-title">Chat</div><div className="page-sub">Talk to any model you registered.</div></div></div>
        <EmptyState
          title="No models registered yet"
          sub="Chat runs against models from your own providers. Connect a provider and register a model in the Model Hub first — nothing is bundled."
          action={<a className="btn btn-primary" href="#/model-hub">Go to Model Hub</a>}
        />
      </div>
    );
  }

  return (
    <div className="page chat-page">
      {node}
      <div className="page-header" style={{ marginBottom: 10 }}>
        <div>
          <div className="page-title">Chat</div>
          <div className="page-sub">A simple, direct line to the model you choose. Your keys, your provider, your data.</div>
        </div>
        <div className="row">
          {(models?.length ?? 0) > 10 && (
            <input className="input" style={{ width: 170 }} value={modelFilter} onChange={(e) => setModelFilter(e.target.value)} placeholder="Filter models…" aria-label="Filter models" />
          )}
          <select className="input" style={{ minWidth: 280 }} value={modelId} onChange={(e) => setModelId(e.target.value)} aria-label="Model">
            {filteredModels.length === 0 ? (
              <option value="">No models match “{modelFilter}”</option>
            ) : (
              filteredModels.map((m) => <option key={m.id} value={m.id}>{m.displayName} · {m.providerName}</option>)
            )}
          </select>
          <button className="btn" onClick={clear} disabled={messages.length === 0}>Clear</button>
        </div>
      </div>

      <div className="chat-shell">
        <div className="chat-messages" ref={scrollRef}>
          {messages.length === 0 ? (
            <div className="hint" style={{ textAlign: "center", marginTop: 48 }}>
              Send a message to <b>{selectedModel?.displayName}</b>.<br />Responses stream live and token usage is measured from provider-reported counts.
            </div>
          ) : (
            messages.map((m) => (
              <div key={m.id} className={`chat-bubble ${m.role}`}>
                <div className="chat-bubble-meta">
                  <span>{m.role === "user" ? "You" : selectedModel?.displayName ?? "Assistant"}</span>
                  {m.role === "assistant" && (m.tokens != null || (streaming && m.id === messages[messages.length - 1]?.id && liveTokens != null)) && (
                    <span className="mono hint">{(m.tokens ?? liveTokens)?.toLocaleString()} tokens{m.costUsd != null ? ` · $${m.costUsd.toFixed(6)} est.` : ""}</span>
                  )}
                </div>
                {m.role === "user"
                  ? <div className="chat-bubble-body">{m.content}</div>
                  : <ModelOutput content={m.content || (streaming ? "▍" : "")} maxHeight={480} />}
              </div>
            ))
          )}
        </div>

        <form className="chat-composer" onSubmit={(e) => { e.preventDefault(); send(); }}>
          <textarea
            className="input chat-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder={`Message ${selectedModel?.displayName ?? "…"} — Enter to send, Shift+Enter for newline`}
            rows={2}
          />
          {streaming
            ? <button type="button" className="btn btn-danger" onClick={stop}>Stop</button>
            : <button type="submit" className="btn btn-primary" disabled={!input.trim()}>Send</button>}
        </form>
      </div>
    </div>
  );
}
