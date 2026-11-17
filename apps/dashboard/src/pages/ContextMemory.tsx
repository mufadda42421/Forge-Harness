import { useEffect, useState } from "react";
import { api, errMessage } from "../api";
import { ConfirmButton, Panel, Spinner, useToastState } from "../components";
import { CodeBlock } from "../components/CodeBlock";

interface Project { id: string; name: string; rootPath: string | null }
interface Doc { id: string; scope: string; title: string; content: string; projectId: string | null; agentId: string | null; version: number; updatedAt: number }
interface MemoryEntry { id: string; scope: string; content: string; source: string; createdAt: number }

export function ContextMemory() {
  const [tab, setTab] = useState<"documents" | "memory" | "projects">("documents");
  const [documents, setDocuments] = useState<Doc[] | null>(null);
  const [memory, setMemory] = useState<MemoryEntry[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [docForm, setDocForm] = useState({ title: "", content: "", scope: "global", projectId: "" });
  const [memoryForm, setMemoryForm] = useState({ content: "", scope: "global" });
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<Array<{ document: Doc; score: number }> | null>(null);
  const { show, node } = useToastState();

  const refresh = () => {
    api.get<{ documents: Doc[] }>("/api/v1/context/documents").then((r) => setDocuments(r.documents)).catch(() => undefined);
    api.get<{ memory: MemoryEntry[] }>("/api/v1/context/memory").then((r) => setMemory(r.memory)).catch(() => undefined);
    api.get<{ projects: Project[] }>("/api/v1/context/projects").then((r) => setProjects(r.projects)).catch(() => undefined);
  };
  useEffect(() => { refresh(); }, []);

  const createDocument = async () => {
    try {
      await api.post("/api/v1/context/documents", {
        title: docForm.title,
        content: docForm.content,
        scope: docForm.scope,
        projectId: docForm.scope === "project" ? docForm.projectId || null : null,
      });
      setDocForm({ ...docForm, title: "", content: "" });
      show("Context document saved. It will only be injected into runs whose scope matches, and only when lexical relevance is non-zero.");
      refresh();
    } catch (e) { show(errMessage(e), { error: true }); }
  };

  const runSearch = async () => {
    if (!search.trim()) { setSearchResults(null); return; }
    try {
      const r = await api.get<{ results: Array<{ document: Doc; score: number }> }>(`/api/v1/context/documents/search?q=${encodeURIComponent(search)}`);
      setSearchResults(r.results);
    } catch (e) { show(errMessage(e), { error: true }); }
  };

  const addMemory = async () => {
    try {
      await api.post("/api/v1/context/memory", { content: memoryForm.content, scope: memoryForm.scope });
      setMemoryForm({ ...memoryForm, content: "" });
      refresh();
    } catch (e) { show(errMessage(e), { error: true }); }
  };

  const createProject = async () => {
    const name = window.prompt("Project name");
    if (!name) return;
    const rootPath = window.prompt("Root path (optional)") ?? null;
    try {
      await api.post("/api/v1/context/projects", { name, rootPath: rootPath || null });
      refresh();
    } catch (e) { show(errMessage(e), { error: true }); }
  };

  return (
    <div className="page">
      {node}
      <div className="page-header">
        <div>
          <div className="page-title">Context &amp; Memory</div>
          <div className="page-sub">User-authored context documents and memory. Nothing is ever sent anywhere except to providers you explicitly run.</div>
        </div>
        <div className="row">
          <button className={`btn${tab === "documents" ? " btn-primary" : ""}`} onClick={() => setTab("documents")}>Documents</button>
          <button className={`btn${tab === "memory" ? " btn-primary" : ""}`} onClick={() => setTab("memory")}>Memory</button>
          <button className={`btn${tab === "projects" ? " btn-primary" : ""}`} onClick={() => setTab("projects")}>Projects</button>
        </div>
      </div>

      {tab === "documents" && (
        <div className="two-col" style={{ gridTemplateColumns: "4fr 7fr" }}>
          <Panel title="Add context document">
            <div className="field"><label className="label">Title *</label><input className="input" value={docForm.title} onChange={(e) => setDocForm({ ...docForm, title: e.target.value })} placeholder="Architecture notes" /></div>
            <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
              <div className="field"><label className="label">Scope</label>
                <select className="input" value={docForm.scope} onChange={(e) => setDocForm({ ...docForm, scope: e.target.value })}>
                  <option value="global">global</option>
                  <option value="project">project</option>
                  <option value="agent">agent</option>
                </select>
              </div>
              {docForm.scope === "project" && (
                <div className="field"><label className="label">Project</label>
                  <select className="input" value={docForm.projectId} onChange={(e) => setDocForm({ ...docForm, projectId: e.target.value })}>
                    <option value="">Select…</option>
                    {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
              )}
            </div>
            <div className="field"><label className="label">Content (markdown/text) *</label><textarea className="input textarea" style={{ minHeight: 160 }} value={docForm.content} onChange={(e) => setDocForm({ ...docForm, content: e.target.value })} placeholder="# Conventions&#10;- …" /></div>
            <button className="btn btn-primary" disabled={!docForm.title.trim() || !docForm.content.trim()} onClick={createDocument}>Save document</button>
            <hr className="divider" />
            <div className="panel-title">Search (lexical)</div>
            <div className="row">
              <input className="input" placeholder="search documents…" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === "Enter" && runSearch()} />
              <button className="btn" onClick={runSearch}>Search</button>
            </div>
            {searchResults && (
              <div style={{ marginTop: 8 }}>
                {searchResults.length === 0 ? <div className="hint">No matches.</div> : searchResults.map((r) => (
                  <div key={r.document.id} className="row" style={{ justifyContent: "space-between", borderBottom: "1px solid var(--border)", padding: "5px 0" }}>
                    <span className="mono" style={{ fontSize: 11 }}>{r.document.title}</span>
                    <span className="badge info">score {r.score.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            )}
          </Panel>
          <Panel title="Saved documents">
            {documents === null ? <Spinner /> : documents.length === 0 ? (
              <div className="hint">No context documents. Write the first one — e.g. your architecture overview or coding conventions — and agents in matching scope will receive it.</div>
            ) : documents.map((d) => (
              <div key={d.id} className="panel" style={{ background: "var(--bg-raised)", marginBottom: 10 }}>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <div>
                    <div style={{ fontWeight: 600 }}>{d.title} <span className="badge">{d.scope}</span> <span className="hint">v{d.version}</span></div>
                    <div className="hint">updated {new Date(d.updatedAt).toLocaleString()}</div>
                  </div>
                  <ConfirmButton label="Delete" onConfirm={async () => { await api.del(`/api/v1/context/documents/${d.id}`); refresh(); }} />
                </div>
                <CodeBlock code={`${d.content.slice(0, 600)}${d.content.length > 600 ? "\n…" : ""}`} language="markdown" maxHeight={140} />
              </div>
            ))}
          </Panel>
        </div>
      )}

      {tab === "memory" && (
        <div className="two-col" style={{ gridTemplateColumns: "4fr 7fr" }}>
          <Panel title="Add memory entry">
            <div className="field"><label className="label">Scope</label>
              <select className="input" value={memoryForm.scope} onChange={(e) => setMemoryForm({ ...memoryForm, scope: e.target.value })}>
                <option value="global">global</option><option value="project">project</option><option value="agent">agent</option>
              </select>
            </div>
            <div className="field"><label className="label">Memory *</label><textarea className="input textarea" style={{ minHeight: 80 }} value={memoryForm.content} onChange={(e) => setMemoryForm({ ...memoryForm, content: e.target.value })} placeholder="A durable fact worth remembering, e.g. 'The API uses snake_case'…" /></div>
            <button className="btn btn-primary" disabled={!memoryForm.content.trim()} onClick={addMemory}>Save memory</button>
            <div className="hint" style={{ marginTop: 8 }}>Memory is user-authored or explicitly agent-sourced. It is never written without your action and never leaves the machine except to providers you run.</div>
          </Panel>
          <Panel title="Memory entries">
            {memory === null ? <Spinner /> : memory.length === 0 ? <div className="hint">Empty.</div> : memory.map((m) => (
              <div key={m.id} className="row" style={{ justifyContent: "space-between", borderBottom: "1px solid var(--border)", padding: "8px 0" }}>
                <div><span className="badge">{m.scope}</span> <span className="hint">{m.source}</span><div style={{ marginTop: 3 }}>{m.content}</div></div>
                <ConfirmButton label="✕" className="btn btn-small btn-ghost" onConfirm={async () => { await api.del(`/api/v1/context/memory/${m.id}`); refresh(); }} />
              </div>
            ))}
          </Panel>
        </div>
      )}

      {tab === "projects" && (
        <Panel title="Projects" actions={<button className="btn btn-primary" onClick={createProject}>+ New Project</button>}>
          {projects.length === 0 ? <div className="hint">No projects. Projects scope context documents and memory.</div> : (
            <table className="table">
              <thead><tr><th>Name</th><th>Root path</th><th></th></tr></thead>
              <tbody>
                {projects.map((p) => (
                  <tr key={p.id}>
                    <td style={{ fontWeight: 600 }}>{p.name}</td>
                    <td className="mono">{p.rootPath ?? "—"}</td>
                    <td><ConfirmButton label="Delete" onConfirm={async () => { await api.del(`/api/v1/context/projects/${p.id}`); refresh(); }} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      )}
    </div>
  );
}
