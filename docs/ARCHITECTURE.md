# Architecture

## Overview

Forge Harness is a local-first, BYOK-first AI infrastructure platform with three deployable layers:

```
┌─────────────────────────────────────────────────────────────┐
│  Dashboard (React+Vite, dark design system, 12 surfaces)     │
├─────────────────────────────────────────────────────────────┤
│  API (Express, /api/v1, Zod-validated, SSE streaming)        │
├──────────────┬───────────────────────┬──────────────────────┤
│  Core engine │  Database (Drizzle)   │  Security             │
│  providers   │  30 normalized tables │  AES-256-GCM cipher   │
│  router      │  FK + indexes + WAL   │  redaction            │
│  agents      │  migrations (drizzle) │  SSRF guard           │
│  orchestrator│                       │                       │
│  workflows   │                       │                       │
│  context     │                       │                       │
│  tools+MCP   │                       │                       │
│  benchmarks  │                       │                       │
│  opencode    │                       │                       │
└──────────────┴───────────────────────┴──────────────────────┘
```

## Key invariants

1. **Zero preloaded AI anything.** No provider instances, model catalogs, or keys ship. First-run is empty; onboarding is explicit. This is enforced structurally: the only code paths that touch providers require a user-created row in `providers`.
2. **Plaintext secrets never persist.** `credential_secrets` stores only AES-256-GCM ciphertext. `provider_credentials_metadata` stores last-4 hints. Decryption happens in-memory, per request, and never reaches logs (redactSecrets on every error path).
3. **Never silently reroute.** `ModelRouter.resolveModel(modelRowId)` resolves to exactly one configured provider. There is no hidden fallback chain; retries are same-provider with backoff.
4. **Never invent.** Capabilities default to `unknown`; pricing defaults to null; costs are returned as `null` (or `estimatedCostUsd` explicitly labeled an estimate); quality scores are manual or LLM-as-judge labeled subjective.
5. **Bounded execution.** Agents loop ≤ `executionLimit`; evaluator ≤ 5 iterations; workflows are validated acyclic server-side; cancellation propagates via AbortSignal.
6. **Human-in-the-loop.** Approval nodes pause the graph; `/workflows/executions/:id/approve` resumes from rehydrated state (node outputs sourced from persisted `agent_messages`).
7. **Tools are deny-by-default.** Agents see zero tools until explicitly granted; `dangerous` tools always require approval; every execution is logged.

## Request flow (inference)

```
UI → POST /api/v1/router/chat{ modelRowId, messages }
   → Zod validation
   → ModelRouter.resolveModel: join models→providers, check enabled,
     decrypt key (if any), build ProviderConfig
   → adapter.chatCompletion (fetch, timeout, retries same-provider)
   → normalize (OpenAI/Anthropic/Gemini/Ollama dialect → shared result)
   → record model_requests (success/error) + usage_records (transaction)
   → cost = estimate(usage, user pricing) or null
```

## Workflow execution with approval pause/resume

- Run → insert `workflow_executions` (status `running`) → Kahn-style ready-set loop, ready nodes run in parallel.
- Node outputs persist as `agent_messages` with `meta.nodeKey`.
- Approval node without a matching key in `approvedNodes` throws `ApprovalRequired` → status `awaiting_approval`, pending node key stored in `outputJson`.
- Resume: re-invoke with same `executionId`; completed nodes are rehydrated from messages; only the approval node (now approved) and its downstream run. Failed nodes fail the run but don't wedge the graph.

## Streaming

SSE (`text/event-stream`): `delta` / `tool_call_delta` / `usage` / `done` events from each adapter, proxied through the router, consumed via `EventSource`-style parsing in the UI where needed and raw fetch for full control. Client disconnect aborts the upstream provider request (`res.on('close')` + `writableEnded` guard).
