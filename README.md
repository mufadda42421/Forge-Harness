# Forge Harness

**BYOK-first AI infrastructure and multi-agent orchestration platform.**
Your models. Your keys. Your agents. Your workflows. Your infrastructure.

Forge Harness is an independent, provider-agnostic AI harness — not a chatbot wrapper, not a subscription with bundled models. It ships with **zero providers, zero models, zero API keys**. You bring your own: any OpenAI-compatible, Anthropic-compatible, Google Gemini, Ollama, OpenRouter, or custom HTTP inference endpoint.

```
Your models. Your keys. Your agents.
```

- **Chat** — a direct streaming chat against any registered model (SSE, token counts, local persistence).
- **Code** — your projects displayed: browse a tree, read with syntax highlighting, edit and save files — all sandboxed to the project root; `.env` and secret-looking paths are never listed or served.

## Highlights

- **100% BYOK** — no preconfigured providers, no bundled credentials, no preloaded model catalogs. The app is fully usable without connecting anything: manage agents, design workflows, configure tools — only inference requires your own provider.
- **AES-256-GCM credential storage** — keys are encrypted at rest, masked in the UI (last-4 hint), redacted from logs, and never returned by the API.
- **Provider-independent router** — capability validation, streaming, retries with backoff, timeouts, cancellation, usage/cost tracking, and *explicit only* fallback (Forge Harness never silently switches provider or model).
- **Agent Studio** — reusable agent configs with model assignment, system instructions, execution limits, tool grants (allowlist, never automatic) and bounded tool-call loops.
- **Multi-agent orchestrator** — sequential, parallel, hierarchical (supervisor), evaluator/critic and debate patterns, all bounded; human-in-the-loop approval checkpoints.
- **Visual workflow builder** — versioned, validated (acyclic) graphs with agent/model/tool/condition/approval/output nodes and pause/resume on approval.
- **Model Arena** — side-by-side comparison of your models on one prompt; manual scoring + optional LLM-as-judge (labeled subjective).
- **Benchmarks** — deterministic suites (substring/regex) with repeat counts, historical aggregates, JSON export.
- **Context & memory** — user-authored context documents and memory; lexical relevance; nothing is sent anywhere except to providers you explicitly run.
- **Tools & MCP** — permissioned tool registry with per-agent grants, approval flows, MCP stdio client, execution logs.
- **OpenCode integration** — optional coordination with a running [OpenCode](https://opencode.ai) server via the official `@opencode-ai/sdk`.
- **Analytics** — measured telemetry: requests, tokens (provider-reported), latency, and cost *estimates* from your own pricing config. Never invoices, never invented.

## Native desktop app (Electron)

Forge Harness ships as a real native Windows app — one `ForgeHarness.exe`, one window, one taskbar icon — instead of a browser tab against a separate server. The Electron shell spawns the bundled local engine (single-file CJS server) as a managed child process, waits for `GET /api/v1/health`, then opens the window on `http://127.0.0.1:4789`. The renderer is sandboxed (`contextIsolation`, no Node integration); external links open in your system browser; a second instance focuses the existing window.

Rebuild the native app end-to-end (Windows):

```powershell
pnpm install; pnpm build                     # build everything first
node node_modules\electron\install.js      # only if electron's binary wasn't fetched (pnpm blocks postinstall by default)
node scripts\build-installer.mjs             # server bundle + native deps + dashboard
node scripts\build-desktop.mjs               # wrap into Electron shell (branded exe)
& "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe" installer\ForgeHarness.iss
```

`apps/desktop/main.cjs` is the shell (~150 lines). `installer/staging-electron/` (git-ignored) is the assembled app. `installer/ForgeHarness.iss` produces `installer/Output/ForgeHarness-Setup-0.2.0.exe`.

Verified: silent install → engine + window launch → dashboard HTTP 200 → silent uninstall (user data `~/.forge-harness` is never touched).

## Windows installer (self-contained .exe)

The compiled setup wraps the native app: `installer/Output/ForgeHarness-Setup-0.2.0.exe` (includes the Electron runtime, engine, dashboard, migrations — no prerequisites, no admin; installs per-user to `%LOCALAPPDATA%\Programs\ForgeHarness`). Compilation: `& "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe" installer\ForgeHarness.iss`. The compiled output lands in `installer/Output/` (git-ignored).

## Quick start (Windows, native app)

```powershell
pnpm install; pnpm build          # build everything
node scripts\build-installer.mjs  # stage the native app
node scripts\build-desktop.mjs
& "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe" installer\ForgeHarness.iss
# run installer\Output\ForgeHarness-Setup-0.2.0.exe
```

or run from source without packaging: `node_modules/.bin/electron apps/desktop` (requires `apps/dashboard/dist` built and `services/api/dist` built; falls back automatically).

Requirements: Node.js ≥ 20 (24 recommended), pnpm 10 (`npm install -g pnpm@10`).

```bash
pnpm install
pnpm build
node services/api/dist/index.js
# open http://127.0.0.1:4789
```

The server hosts both the API and the built dashboard on **127.0.0.1:4789**. For development with hot reload:

```bash
pnpm dev:api        # API on :4789 (tsx watch)
pnpm dev:dashboard  # Vite dev server on :5173 (proxies /api to :4789)
```

On first launch you will see an empty first-run screen with two actions: **Connect Your First Provider** and **Explore Forge Harness**. Nothing is preloaded, by design.

## Configuration

All configuration is via environment variables (see `.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `FORGE_MASTER_KEY` | auto | Base64 32-byte key for credential encryption. If unset, a `master.key` (0600) is generated in the data dir — the documented **development fallback**. Set this in production. |
| `FORGE_DATA_DIR` | `~/.forge-harness` | SQLite database, master key, generated data |
| `FORGE_DATABASE_PATH` | `$FORGE_DATA_DIR/forge-harness.db` | SQLite file location |
| `FORGE_HOST` | `127.0.0.1` | Bind host. Non-loopback requires `FORGE_API_TOKEN` or the server refuses to start |
| `FORGE_PORT` | `4789` | Bind port |
| `FORGE_API_TOKEN` | unset | Optional bearer token for all `/api/*` requests |
| `FORGE_DASHBOARD_DIST` | `apps/dashboard/dist` | Custom dashboard build location |

## Credentials: how they're protected

1. API keys are encrypted locally with **AES-256-GCM** before touching disk (`credential_secrets` table). Plaintext exists only in memory for the duration of an outbound request.
2. The UI shows a **last-4 hint** (`••••abcd`), never the key. The API never returns keys.
3. Custom provider headers (which may contain secrets) are stored locally but **redacted** in every API response and in logs.
4. Settings keys that look secret (`*key*`, `*token*`, `*password*`, …) are rejected — credentials belong to the provider/OpenCode credential endpoints.
5. `FORGE_API_TOKEN`, if set, gates the entire API with a constant-time comparison. The server refuses non-loopback binds without it.
6. Deleting a provider deletes its credentials. Rotating a key overwrites and re-encrypts.

## Repo layout

```
apps/dashboard      React + Vite dark-first dashboard (design system in src/index.css)
services/api        Express API (/api/v1/*), serves the dashboard, SSE streaming
packages/shared     Types, errors, cost estimation
packages/database   Drizzle schema (30 tables, normalized, FKs, indexes) + migrations
packages/security   AES-256-GCM cipher, log redaction, SSRF guard
packages/core       The engine:
                    providers/  OpenAI-compatible, Anthropic, Gemini, Ollama (+ factory)
                    router/     Model routing, retries, usage/cost recording
                    agents/     Bounded agent execution with tool loop
                    orchestrator/ sequential · parallel · hierarchical · evaluator · debate
                    workflow/   Graph validation (acyclic) + versioned DAG runner w/ approvals
                    context/    Lexical-relevance context assembly (no embeddings required)
                    tools/      Tool permission policy + executor + MCP stdio client
                    opencode/   @opencode-ai/sdk adapter (optional)
                    benchmarks/ Deterministic benchmark runner
docs/               Architecture & decision records
```

## Connecting your first provider

1. **Model Hub → Providers → Connect Provider**. Pick a compatibility type (`openai`, `anthropic`, `google`, `ollama`, `openrouter`, `custom-http`), paste your base URL and key.
2. Click **Test**. The result is real — one lightweight request to the endpoint (`/models` or native Ollama `/api/tags`). Latency and discovered model count are shown.
3. Click **Discover…** to list the provider's models and import them as *registered* models, or register manually.
4. Optionally configure per-1M pricing and capability flags per model. **Unknown is the default — Forge Harness never invents capabilities or pricing.**
5. Send a request: Overview → or any page that runs inference. Watch tokens/latency appear in Analytics.

## API overview

All endpoints live under `/api/v1`. Groups: `overview`, `providers`, `models`, `router` (chat + SSE stream), `agents`, `orchestrator`, `workflows`, `arena`, `benchmarks`, `context`, `code` (project registry + sandboxed file tree/read/write), `tools`, `opencode`, `analytics`, `settings`, plus `health`. Request bodies are validated with Zod; errors share a consistent `{ error: { code, message, details? } }` shape. Streaming endpoints are Server-Sent Events (`/api/v1/router/chat/stream`). The Code API refuses path traversal (realpath prefix check), hides `.env`/secret-looking files entirely, caps reads at 1.5 MB and skips `node_modules`/`.git`/`dist`.

## Testing

```bash
pnpm test        # unit tests (shared, security, core)
pnpm typecheck   # strict TS across the workspace
```

Provider adapters are covered by tests with mocked `fetch` (auth normalization, error mapping). The workflow validator has cycle/connectivity tests. Crypto round-trip/tamper tests live in `packages/security`.

For a **local mock inference endpoint** to demo end-to-end inference without an account, see `docs/DECISIONS.md` § "Mock provider for verification". Point a provider at it like any OpenAI-compatible endpoint.

## OpenCode integration

Optional. Point Forge Harness at a running `opencode serve` instance (default `http://127.0.0.1:4096`):

1. **OpenCode → Add Connection** (base URL + optional basic auth).
2. **Test** — uses official SDK health/session endpoints with a 5s timeout.
3. Create sessions, prompt them, abort them, read message history. Destructive operations still go through OpenCode's own permission system.

Forge Harness remains fully useful without OpenCode.

## Definition of done status

See `PROJECT_STATUS.md` for what is implemented and verified, and what remains.
