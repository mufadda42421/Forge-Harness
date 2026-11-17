# Decision Records

## ADR-001: pnpm workspaces monorepo, TypeScript strict, ESM
Chosen for one dependency graph across dashboard/api/packages. `pnpm-workspace.yaml` with `onlyBuiltDependencies` for better-sqlite3/esbuild. Deviation from npm/yarn: none material; spec called for pnpm + `tsconfig.base.json` + workspaces.

## ADR-002: better-sqlite3 + Drizzle ORM
Local-first per spec. better-sqlite3 v12 (prebuilds for Node 24). Migrations generated with drizzle-kit and applied automatically at startup (`openDatabase`). WAL mode, foreign_keys ON, busy_timeout 5s. 31 tables including spec's full list + `workflow_executions` (needed for run history/pause-resume) and `arena_sessions`.

## ADR-003: No ORM on the hot path for writes of execution telemetry
Drizzle everywhere for consistency (we do sync Drizzle calls inside `better-sqlite3`'s synchronous transactions). Recorded usage is best-effort: logging failures never fail an inference.

## ADR-004: Credential encryption — file-backed AES-256-GCM with env override
Decision: `FORGE_MASTER_KEY` (env, base64) → else auto-generated `master.key` (chmod 0600) in the data dir. This is the documented development fallback; production sets the env key. OS keychain integration is *pluggable* behind `CredentialCipher` but not wired by default (avoids heavyweight native deps; documented honestly in README/Settings). Plaintext lives only in memory per request.

## ADR-005: SSRF guard with private-network allowlist
Cloud metadata (169.254.169.254) and link-local blocked. Loopback/RFC1918 allowed because local model servers (Ollama) are a primary BYOK use case. Documented as an explicit trade-off; strict mode is scaffolded in `assertUrlAllowed`.

## ADR-006: Loopback-only bind; non-loopback requires bearer token
`FORGE_HOST` defaults to `127.0.0.1`. Non-loopback without `FORGE_API_TOKEN` → process refuses to start. If set, constant-time comparison guards `/api/*`. CORS allows only the Vite dev origin and same-origin (no header).

## ADR-007: OpenCode via official @opencode-ai/sdk, isolated adapter
Spec mandates the supported SDK over the raw HTTP API. `OpenCodeClient` wraps `createOpencodeClient` with 5s timeouts and graceful degradation to normalized ForgeErrors. Endpoint paths not needed when SDK is used; Forge Harness functions fully without an OpenCode server.

## ADR-008: Mock provider for verification (not shipped, not preloaded)
To *verify* adapters/streaming/agents end-to-end without a provider account, a local OpenAI-compatible mock was run during development (echo responses, SSE chunks, /v1/models discovery). It is a test double only — never registered in shipped code, never auto-created. Real endpoints behave the same through the same code path.

## ADR-009: Tool manager with MCP stdio client and dry permission model
`executeTool` enforces `decideToolPolicy` before every run and logs every outcome (success/error/denied/awaiting_approval). MCP support implements the JSON-RPC `initialize` → `tools/call` handshake over stdio with hard timeout and SIGKILL cleanup. HTTP tools are SSRF-guarded. No other side-effecting tools run without grants.

## ADR-010: Schema-migrations over push-based sync
`drizzle-kit generate` produces versioned SQL in `packages/database/drizzle/`. Fresh installs migrate cleanly at boot; CI could replay the same files. No `drizzle-kit push` against user databases.

## ADR-011: Workflow runner resume semantics
Paired with approval nodes. Completed node outputs are rehydrated from persisted `agent_messages` so a resumed execution continues deterministically. Skipped (condition-guarded) nodes produce `"(skipped)"` markers rather than executing.

## ADR-012: Cost honesty
Every inference result carries `estimatedCostUsd: number | null` (null when pricing or usage is unknown) and `costIsEstimated: true`. Analytics surfaces "estimate only — not an invoice". Tokens are summed from provider-reported values only.
