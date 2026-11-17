import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errMessage } from "../api";
import { ConfirmButton, Panel, Spinner, useToastState } from "../components";
import { CodeBlock } from "../components/CodeBlock";

interface ProjectRow { id: string; name: string; rootPath: string | null; createdAt: number }
interface TreeEntry { path: string; type: "file" | "dir"; size: number }

const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", json: "json", md: "markdown", markdown: "markdown",
  css: "css", html: "html", xml: "xml", svg: "xml",
  sql: "sql", yaml: "yaml", yml: "yaml", sh: "bash", bash: "bash", zsh: "bash",
  go: "go", rs: "rust", java: "java", cpp: "cpp", cc: "cpp", c: "cpp", h: "cpp", hpp: "cpp",
  dockerfile: "dockerfile", toml: "yaml", gradle: "java", properties: "yaml",
};
const langFor = (p: string) => LANG_BY_EXT[p.split(".").pop()?.toLowerCase() ?? ""] ?? "text";

export function Code() {
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(() => localStorage.getItem("forge.code.project"));
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [treeLoading, setTreeLoading] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set([""]));
  const [filePath, setFilePath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>("");
  const [fileSize, setFileSize] = useState(0);
  const [fileLoading, setFileLoading] = useState(false);
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newProject, setNewProject] = useState({ name: "", rootPath: "" });
  const [showNewProject, setShowNewProject] = useState(false);
  const [newFilePath, setNewFilePath] = useState<string | null>(null);
  const { show, node } = useToastState();
  const showRef = useRef(show);
  showRef.current = show;

  const refreshProjects = () =>
    api.get<{ projects: ProjectRow[] }>("/api/v1/code/projects").then((r) => {
      setProjects(r.projects);
      setSelectedId((cur) => cur ?? r.projects[0]?.id ?? null);
    }).catch((e) => show(errMessage(e), { error: true }));
  useEffect(() => { refreshProjects(); }, []);

  useEffect(() => {
    if (selectedId) localStorage.setItem("forge.code.project", selectedId);
  }, [selectedId]);

  const selected = projects?.find((p) => p.id === selectedId) ?? null;

  const loadTree = useCallback((id: string) => {
    setTreeLoading(true);
    api.get<{ entries: TreeEntry[]; truncated: boolean }>(`/api/v1/code/projects/${id}/tree`)
      .then((r) => { setEntries(r.entries); setTruncated(r.truncated); setExpanded(new Set([""])); })
      .catch((e) => showRef.current(errMessage(e), { error: true }))
      .finally(() => setTreeLoading(false));
  }, []);

  useEffect(() => {
    if (selectedId) {
      setFilePath(null);
      setFileContent("");
      setDirty(false);
      loadTree(selectedId);
    }
  }, [selectedId, loadTree]);

  const openFile = async (path: string) => {
    if (!selectedId) return;
    setFileLoading(true);
    try {
      const r = await api.get<{ content: string; size: number }>(`/api/v1/code/projects/${selectedId}/file?path=${encodeURIComponent(path)}`);
      setFilePath(path);
      setFileContent(r.content);
      setFileSize(r.size);
      setMode("view");
      setDirty(false);
    } catch (e) { show(errMessage(e), { error: true }); }
    finally { setFileLoading(false); }
  };

  const saveFile = async () => {
    if (!selectedId || !filePath || saving) return;
    setSaving(true);
    try {
      await api.put(`/api/v1/code/projects/${selectedId}/file`, { path: filePath, content: fileContent });
      setDirty(false);
      setFileSize(new Blob([fileContent]).size);
      show(`Saved ${filePath}`);
    } catch (e) { show(errMessage(e), { error: true }); }
    finally { setSaving(false); }
  };

  const createFile = async () => {
    if (!selectedId || !newFilePath?.trim()) return;
    try {
      await api.put(`/api/v1/code/projects/${selectedId}/file`, { path: newFilePath.trim(), content: "" });
      show(`Created ${newFilePath.trim()}`);
      const created = newFilePath.trim();
      setNewFilePath(null);
      loadTree(selectedId);
      openFile(created);
    } catch (e) { show(errMessage(e), { error: true }); }
  };

  const createProject = async () => {
    try {
      const r = await api.post<{ project: ProjectRow }>("/api/v1/code/projects", { name: newProject.name, rootPath: newProject.rootPath });
      setNewProject({ name: "", rootPath: "" });
      setShowNewProject(false);
      setSelectedId(r.project.id);
      refreshProjects();
    } catch (e) { show(errMessage(e), { error: true }); }
  };

  const removeProject = async (id: string) => {
    try {
      await api.del(`/api/v1/code/projects/${id}`);
      show("Project removed. Files on disk were not touched.");
      if (selectedId === id) setSelectedId(null);
      refreshProjects();
    } catch (e) { show(errMessage(e), { error: true }); }
  };

  const toggleDir = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };

  // Build a recursive folder structure from the flat entries list
  const tree = useMemo(() => {
    interface Node { name: string; path: string; type: "file" | "dir"; size: number; children: Node[] }
    const rootNode: Node = { name: "", path: "", type: "dir", size: 0, children: [] };
    const dirMap = new Map<string, Node>([["", rootNode]]);
    for (const entry of entries) {
      const idx = entry.path.lastIndexOf("/");
      const parentPath = idx === -1 ? "" : entry.path.slice(0, idx);
      const name = idx === -1 ? entry.path : entry.path.slice(idx + 1);
      const parent = dirMap.get(parentPath);
      if (!parent) continue;
      const node: Node = { name, path: entry.path, type: entry.type, size: entry.size, children: [] };
      if (entry.type === "dir") dirMap.set(entry.path, node);
      parent.children.push(node);
    }
    const sortNodes = (n: Node) => {
      n.children.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
      n.children.forEach(sortNodes);
    };
    sortNodes(rootNode);
    return rootNode;
  }, [entries]);

  const renderNode = (node: typeof tree, depth: number) => (
    <div key={node.path}>
      {node.type === "dir" ? (
        <>
          <button className="tree-row dir" style={{ paddingLeft: 10 + depth * 14 }} onClick={() => toggleDir(node.path)}>
            <span className="tree-caret">{expanded.has(node.path) ? "▾" : "▸"}</span>
            <span className="tree-folder">▸</span> {node.name}
          </button>
          {expanded.has(node.path) && node.children.map((child) => renderNode(child, depth + 1))}
        </>
      ) : (
        <button className={`tree-row file${filePath === node.path ? " active" : ""}`} style={{ paddingLeft: 10 + depth * 14 }} onClick={() => openFile(node.path)}>
          <span className="tree-caret" />
          <span className="tree-file-icon">·</span> {node.name}
          <span className="tree-size">{formatSize(node.size)}</span>
        </button>
      )}
    </div>
  );

  return (
    <div className="page code-page" style={{ maxWidth: "none" }}>
      {node}
      <div className="page-header">
        <div>
          <div className="page-title">Code</div>
          <div className="page-sub">Your projects, displayed — browse, read and edit files right here. Reads and writes are sandboxed to the project root; secret-looking paths are always refused.</div>
        </div>
        <button className="btn btn-primary" onClick={() => setShowNewProject((v) => !v)}>+ New Project</button>
      </div>

      {showNewProject && (
        <Panel title="Add a project">
          <div className="grid" style={{ gridTemplateColumns: "1fr 2fr auto", gap: 10, alignItems: "end" }}>
            <div className="field" style={{ marginBottom: 0 }}><label className="label">Name *</label><input className="input" autoFocus value={newProject.name} onChange={(e) => setNewProject({ ...newProject, name: e.target.value })} placeholder="forge-harness" /></div>
            <div className="field" style={{ marginBottom: 0 }}><label className="label">Root path (folder) *</label><input className="input mono" value={newProject.rootPath} onChange={(e) => setNewProject({ ...newProject, rootPath: e.target.value })} placeholder="D:\my-project" /></div>
            <div className="row"><button className="btn" onClick={() => setShowNewProject(false)}>Cancel</button><button className="btn btn-primary" disabled={!newProject.name.trim() || !newProject.rootPath.trim()} onClick={createProject}>Add Project</button></div>
          </div>
        </Panel>
      )}

      <div className="grid" style={{ gridTemplateColumns: "230px 280px 1fr", gap: 12, alignItems: "start", marginTop: 12 }}>
        {/* Projects */}
        <Panel title={`Projects${projects?.length ? ` (${projects.length})` : ""}`}>
          {projects === null ? <Spinner /> : projects.length === 0 ? (
            <div className="hint">No projects yet. Add one — a folder on this machine — and its files will appear here for browsing and editing. Projects registered here also power Context &amp; Memory scoping.</div>
          ) : projects.map((p) => (
            <div key={p.id} className={`project-item${selectedId === p.id ? " active" : ""}`}>
              <button className="project-item-main" onClick={() => setSelectedId(p.id)}>
                <div style={{ fontWeight: 600, fontSize: 12 }}>{p.name}</div>
                <div className="mono hint" style={{ fontSize: 9.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.rootPath}</div>
              </button>
              <ConfirmButton label="✕" className="btn btn-small btn-ghost" onConfirm={() => removeProject(p.id)} />
            </div>
          ))}
        </Panel>

        {/* Tree */}
        <Panel title="Files" actions={selected && (
          <button className="btn btn-small" onClick={() => setNewFilePath(newFilePath === null ? "" : null)} title="Create a new file">+ New file</button>
        )}>
          {newFilePath !== null && (
            <div className="row" style={{ marginBottom: 8 }}>
              <input className="input mono" autoFocus placeholder="path/to/file.ts" value={newFilePath} onChange={(e) => setNewFilePath(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") createFile(); if (e.key === "Escape") setNewFilePath(null); }} />
              <button className="btn btn-small btn-primary" onClick={createFile}>Create</button>
            </div>
          )}
          {!selected ? <div className="hint">Select a project.</div> : treeLoading ? <Spinner /> : entries.length === 0 ? (
            <div className="hint">Empty folder (or unreadable).</div>
          ) : (
            <div className="file-tree">
              {tree.children.map((child) => renderNode(child, 0))}
              {truncated && <div className="hint" style={{ padding: "6px 10px" }}>…tree truncated (4000 entries)</div>}
            </div>
          )}
        </Panel>

        {/* File panel */}
        <Panel title={filePath ? "Editor" : "File"} actions={filePath && (
          <div className="row">
            <div className="row" role="tablist">
              <button className={`btn btn-small${mode === "view" ? " btn-primary" : ""}`} onClick={() => setMode("view")}>View</button>
              <button className={`btn btn-small${mode === "edit" ? " btn-primary" : ""}`} onClick={() => setMode("edit")}>Edit</button>
            </div>
            {mode === "edit" && <button className="btn btn-small btn-primary" disabled={saving || !dirty} onClick={saveFile}>{saving ? "Saving…" : "Save"}</button>}
            <button className="btn btn-small" onClick={async () => { try { await navigator.clipboard.writeText(fileContent); show("Copied to clipboard."); } catch { show("Clipboard unavailable", { error: true }); } }}>Copy</button>
          </div>
        )}>
          {!filePath ? (
            <div className="hint">Pick a file from the tree — it opens with syntax highlighting. Switch to Edit to change it; Ctrl+S saves. Files are only read from / written inside the project folder.</div>
          ) : fileLoading ? <Spinner /> : mode === "view" ? (
            <>
              <div className="mono hint" style={{ marginBottom: 8 }}>{filePath} · {formatSize(fileSize)} · {langFor(filePath)}</div>
              <CodeBlock code={fileContent} language={langFor(filePath)} maxHeight={620} />
            </>
          ) : (
            <>
              <div className="mono hint" style={{ marginBottom: 8 }}>{filePath} · {dirty ? "unsaved changes" : "saved"} · Ctrl+S to save</div>
              <textarea
                className="input code-editor"
                value={fileContent}
                onChange={(e) => { setFileContent(e.target.value); setDirty(true); }}
                onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); saveFile(); } }}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
              />
            </>
          )}
        </Panel>
      </div>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
