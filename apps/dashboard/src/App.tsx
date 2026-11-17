import { useEffect, useState } from "react";
import { Overview } from "./pages/Overview";
import { Chat } from "./pages/Chat";
import { Code } from "./pages/Code";
import { ModelHub } from "./pages/ModelHub";
import { Arena } from "./pages/Arena";
import { Agents } from "./pages/Agents";
import { Orchestrator } from "./pages/Orchestrator";
import { Workflows } from "./pages/Workflows";
import { Benchmarks } from "./pages/Benchmarks";
import { ContextMemory } from "./pages/ContextMemory";
import { ToolsMcp } from "./pages/ToolsMcp";
import { OpenCode } from "./pages/OpenCode";
import { Analytics } from "./pages/Analytics";
import { Settings } from "./pages/Settings";
import { api } from "./api";

const PRIMARY_NAV = [
  { path: "/overview", label: "Overview", icon: "◈" },
  { path: "/chat", label: "Chat", icon: "◉" },
  { path: "/code", label: "Code", icon: "</>" },
  { path: "/model-hub", label: "Model Hub", icon: "⬡" },
  { path: "/agents", label: "Agents", icon: "⬢" },
  { path: "/orchestrator", label: "Orchestrator", icon: "⤡" },
  { path: "/workflows", label: "Workflows", icon: "⤨" },
  { path: "/tools", label: "Tools & MCP", icon: "⚒" },
  { path: "/opencode", label: "OpenCode", icon: "⌘" },
] as const;

const MORE_NAV = [
  { path: "/arena", label: "Model Arena", icon: "⚔" },
  { path: "/benchmarks", label: "Benchmarks", icon: "▤" },
  { path: "/context", label: "Context & Memory", icon: "▦" },
  { path: "/analytics", label: "Analytics", icon: "∿" },
  { path: "/settings", label: "Settings", icon: "⚙" },
] as const;

const ROUTES: Record<string, () => JSX.Element> = {
  "/overview": Overview,
  "/chat": Chat,
  "/code": Code,
  "/model-hub": ModelHub,
  "/arena": Arena,
  "/agents": Agents,
  "/orchestrator": Orchestrator,
  "/workflows": Workflows,
  "/benchmarks": Benchmarks,
  "/context": ContextMemory,
  "/tools": ToolsMcp,
  "/opencode": OpenCode,
  "/analytics": Analytics,
  "/settings": Settings,
};

function currentPath(): string {
  const hash = window.location.hash.replace(/^#/, "") || "/overview";
  return hash.split("?")[0] ?? "/overview";
}

function useTheme(): ["dark" | "light", () => void] {
  const [theme, setTheme] = useState<"dark" | "light">(() => (document.documentElement.dataset.theme === "light" ? "light" : "dark"));
  const toggle = () => {
    setTheme((t) => {
      const next = t === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem("forge.theme", next); } catch { /* private mode */ }
      return next;
    });
  };
  return [theme, toggle];
}

export function App() {
  const [path, setPath] = useState(currentPath());
  const [moreOpen, setMoreOpen] = useState(() => MORE_NAV.some((i) => i.path === currentPath()));
  const [workspaces, setWorkspaces] = useState<Array<{ id: string; name: string }>>([]);
  const [theme, toggleTheme] = useTheme();

  useEffect(() => {
    const onHash = () => {
      const p = currentPath();
      setPath(p);
      if (MORE_NAV.some((i) => i.path === p)) setMoreOpen(true);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    api.get<{ projects: Array<{ id: string; name: string }> }>("/api/v1/code/projects")
      .then((r) => setWorkspaces(r.projects))
      .catch(() => setWorkspaces([]));
  }, [path]);

  const Page = ROUTES[path] ?? Overview;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">F</div>
          <div>
            <div className="brand-name">forge<span className="harness-badge">HARNESS</span></div>
            <div className="brand-sub">bring your own keys</div>
          </div>
        </div>

        <a className="new-session-btn" href="#/chat"><span className="plus">＋</span><span className="ns-label">New Session</span></a>

        <div className="side-label">Menu</div>
        {PRIMARY_NAV.map((item) => (
          <a key={item.path} className={`nav-item${path === item.path ? " active" : ""}`} href={`#${item.path}`}>
            <span className="nav-icon">{item.icon}</span>
            <span>{item.label}</span>
          </a>
        ))}
        <button className="more-toggle" onClick={() => setMoreOpen((v) => !v)} aria-expanded={moreOpen}>
          <span className="nav-icon">▦</span>
          <span>More</span>
          <span className={`more-caret${moreOpen ? " open" : ""}`}>▸</span>
        </button>
        {moreOpen && MORE_NAV.map((item) => (
          <a key={item.path} className={`nav-item${path === item.path ? " active" : ""}`} href={`#${item.path}`}>
            <span className="nav-icon">{item.icon}</span>
            <span>{item.label}</span>
          </a>
        ))}

        <div className="side-label">Workspaces</div>
        <a className="ws-item" href="#/chat"><span className="folder">◉</span><span>New Session</span></a>
        {workspaces.length === 0 ? (
          <a className="ws-item" href="#/code"><span className="folder">⌂</span><span>No workspaces yet — add one in Code</span></a>
        ) : (
          workspaces.slice(0, 7).map((w) => (
            <a key={w.id} className="ws-item" href="#/code" title={w.name}>
              <span className="folder">🗀</span>
              <span>{w.name}</span>
            </a>
          ))
        )}

        <div className="sidebar-footer">
          <div className="avatar-dot">FH</div>
          <div className="sf-meta">
            <div className="sf-title">Local instance</div>
            <div className="sf-sub">v0.2.0 · 127.0.0.1:4789</div>
          </div>
          <button className="theme-toggle" onClick={toggleTheme} title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"} aria-label="Toggle theme">
            {theme === "dark" ? "☀" : "☾"}
          </button>
        </div>
      </aside>
      <main className="main">
        <Page />
      </main>
    </div>
  );
}
