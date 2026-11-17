# PROJECT_STATUS — Forge Harness

_Last updated: 2026-11-15._

## What exists (built & verified)

| Area | Status | Verified by |
|---|---|---|
| Monorepo (pnpm workspaces, strict TS, ESM) | ✅ Done | `pnpm install && pnpm build` clean |
| Database: Drizzle + SQLite, 31 tables, FK/indexes/WAL, auto-migrations at boot | ✅ Done | migration replay + table listing; fresh DB migrates at startup |
| Security: AES-256-GCM credential encryption, secret redaction, SSRF guard, loopback-bind enforcement | ✅ Done | unit tests |
| Shared: errors, cost estimation (null when pricing unknown), types | ✅ Done | unit tests |
| Provider adapters: OpenAI-compatible, Anthropic, Gemini, Ollama (+ factory) | ✅ Done | unit tests + mock-endpoint E2E |
| Model router: resolve → validate → decrypt → request, same-provider retries, timeout/cancellation, usage recording | ✅ Done | E2E via local mock: chat, cost math, SSE streaming |
| Model Hub: providers CRUD, key rotation (encrypted), connection test, discovery & import, models CRUD, capability flags, pricing, export/import, masked headers | ✅ Done | HTTP smoke suite |
| Agent Studio: CRUD, example agents (explicit), model assignment enforced, system instructions, limits, per-agent tool grants + approval | ✅ Done | HTTP smoke |
| Orchestrator: sequential, parallel, hierarchical, evaluator (bounded), debate; persisted execution + messages | ✅ Done | HTTP smoke (sequential) |
| Workflows: visual canvas, acyclic validation, versioned saves, run with condition/approval nodes, pause/resume | ✅ Done | HTTP smoke: cycle detection, version save, run success |
| Arena: N-model side-by-side, manual scoring, optional LLM-as-judge, session save/list/delete | ✅ Done | HTTP smoke E2E |
| Benchmarks: suites, cases (substring/regex/none), repeat runs, aggregates (avg/median/min/max), JSON export | ✅ Done | compile + smoke |
| Context: documents CRUD + lexical search, memory CRUD, projects | ✅ Done | unit tests + smoke |
| Tools & MCP: registry, per-agent grants, permission tiers, MCP stdio client, builtin HTTP tool, execution logs | ✅ Done | unit tests + smoke |
| OpenCode: connection CRUD, SDK-backed test/list/create/prompt/abort/messages; graceful degradation | ✅ Done (no live server used) | compile |
| Analytics: summary, by-model, by-provider, recent requests/errors — local, labeled estimates | ✅ Done | HTTP smoke |
| Dashboard: 14 surfaces, dark design system, first-run empty state; Chat + Code panels added | ✅ Done | builds; routes verified |
| Chat panel: streaming SSE chat vs any registered model (Enter send, stop/abort, clear, token counts, localStorage persistence) | ✅ Done | builds; SSE verified end-to-end |
| Code panel: project registry + sandboxed explorer — tree (skips node_modules/.git/dist), read w/ syntax highlighting, edit + Ctrl+S save, create file; `.env`/secrets never listed or served; traversal refused; 1.5 MB cap | ✅ Done & security-tested | HTTP smoke: .env hidden everywhere, traversal refused, read/create/save roundtrip |
| UI polish: hover transitions, focus-visible, page fade-in, skeleton shimmer, custom scrollbars, reduced-motion support | ✅ Done | build + browser snapshot |
| Syntax highlighting for code generation: `CodeBlock` (highlight.js + copy), `ModelOutput` (fenced-code segmentation) | ✅ Done | build + typecheck |
| Windows installer `installer/Output/ForgeHarness-Setup-0.2.0.exe`: v0.2.0, force-closes a running app on upgrade, same AppId as 0.1.0 → in-place upgrade | ✅ Built & upgrade-verified | silent install → re-install over existing → exit 0, files replaced |
| Glass UI: DeepSeek-Harness-style frosted panels, ambient glow, composer-first home, full **light/dark theme toggle** (persisted), icon-only collapse below 1080px | ✅ Done & screenshot-verified | dark + light hero screenshots |
| Native desktop app (Electron): `ForgeHarness.exe` window, sandboxed renderer, managed engine child, single-instance lock | ✅ Built & verified | installed copy launches → engine health 200 |
| Unit tests: 27 passing (shared 3, security 8, core 16) | ✅ Done | `pnpm test` |

## Definition of done (spec §22) — status

- [x] Application starts successfully · first-run empty · nothing preloaded
- [x] Providers/models/keys configurable by the user, encrypted at rest
- [x] Connectivity tests (real HTTP), streaming works, agents run, sequential orchestration runs
- [x] Execution logs persisted; tokens/latency tracked
- [x] OpenCode integration (not exercised against a live server)
- [x] Graceful handling of missing providers
- [x] Automated tests pass; documentation present

## Known limitations (honest)

1. Provider adapters verified against a local mock, not live vendors (Anthropic/Gemini/OpenAI/Ollama paths implemented + unit-tested at the HTTP boundary).
2. Agent tool-call approvals are per-run opt-in; no interactive per-call dialog yet.
3. Dashboard: no undo/redo on canvas; Arena scoring is session-local; no frontend unit tests.
4. `toolPolicy` settings read by core but not yet exposed as dedicated UI toggles.
5. OS keychain backend pluggable but unimplemented (file-backed AES-256-GCM default, documented).
6. OpenCode `/event` SSE proxying not implemented.
7. Cost estimates require user-configured pricing; discovery arrives with null pricing by design.
8. Code panel is deliberately read/edit/create-only (no delete) and refuses secret-looking paths outright.

## Commands

```bash
pnpm install
pnpm build            # build all packages/apps
pnpm test             # unit tests
pnpm typecheck        # strict TS everywhere
node services/api/dist/index.js   # run (serves API + dashboard on 127.0.0.1:4789)
pnpm dev:api / pnpm dev:dashboard / pnpm dev:all
```

Data dir defaults to `~/.forge-harness` (override `FORGE_DATA_DIR`).

## Next recommended tasks (in order)

1. Exercise Anthropic/Gemini/Ollama adapters against live endpoints.
2. Interactive tool-approval dialog in agent runs; `toolPolicy` settings UI.
3. Native messaging host for the Code panel ("Ask about this file" → Chat).
4. OpenCode `/event` SSE proxying to the OpenCode page.
5. Optional OS keychain backend (keytar or DPAPI) behind `CredentialCipher`.
