import { randomUUID } from "node:crypto";
import { sql, relations } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  real,
  uniqueIndex,
  index,
} from "drizzle-orm/sqlite-core";

const id = () => text("id").primaryKey().$defaultFn(() => randomUUID());
const createdAt = () => integer("created_at").notNull().$defaultFn(() => Date.now());
const updatedAt = () => integer("updated_at").notNull().$defaultFn(() => Date.now());
const bool = (name: string) => integer(name, { mode: "boolean" }).notNull().default(false);

/* ---------------------------------- providers ---------------------------------- */

export const providers = sqliteTable(
  "providers",
  {
    id: id(),
    name: text("name").notNull(),
    identifier: text("identifier").notNull().unique(),
    baseUrl: text("base_url").notNull(),
    compatibility: text("compatibility").notNull(), // ProviderCompatibility
    authMethod: text("auth_method").notNull().default("bearer"), // AuthMethod
    customHeadersJson: text("custom_headers_json").notNull().default("{}"),
    timeoutMs: integer("timeout_ms").notNull().default(60_000),
    maxRetries: integer("max_retries").notNull().default(2),
    enabled: bool("enabled"),
    connectionStatus: text("connection_status").notNull().default("untested"),
    lastTestedAt: integer("last_tested_at"),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("providers_enabled_idx").on(t.enabled)],
);

/** Metadata about credentials — never the secret itself. */
export const providerCredentialsMetadata = sqliteTable("provider_credentials_metadata", {
  id: id(),
  providerId: text("provider_id")
    .notNull()
    .references(() => providers.id, { onDelete: "cascade" })
    .unique(),
  authMethod: text("auth_method").notNull(),
  keyHint: text("key_hint"), // e.g. "…last4" — masked, not recoverable
  storageBackend: text("storage_backend").notNull().default("aes-256-gcm-file"),
  rotatedAt: integer("rotated_at"),
  createdAt: createdAt(),
});

/**
 * Encrypted credential material (AES-256-GCM). API keys are never stored in
 * plaintext anywhere. Ciphertext is only decrypted in-memory for a single
 * outbound request, is never logged, and is never returned by the API.
 */
export const credentialSecrets = sqliteTable("credential_secrets", {
  id: id(),
  refType: text("ref_type").notNull().default("provider"), // 'provider' | 'opencode'
  refId: text("ref_id").notNull(),
  ciphertext: text("ciphertext").notNull(),
  iv: text("iv").notNull(),
  authTag: text("auth_tag").notNull(),
  algorithm: text("algorithm").notNull().default("aes-256-gcm"),
  createdAt: createdAt(),
  rotatedAt: integer("rotated_at"),
}, (t) => [uniqueIndex("credential_secrets_ref_idx").on(t.refType, t.refId)]);

/* ----------------------------------- models ----------------------------------- */

export const models = sqliteTable(
  "models",
  {
    id: id(),
    providerId: text("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "cascade" }),
    modelId: text("model_id").notNull(), // identifier sent to the provider
    displayName: text("display_name").notNull(),
    contextWindow: integer("context_window"),
    maxOutputTokens: integer("max_output_tokens"),
    inputCostPer1M: real("input_cost_per_1m"),
    outputCostPer1M: real("output_cost_per_1m"),
    costConfigured: bool("cost_configured"),
    supportsStreaming: integer("supports_streaming", { mode: "boolean" }),
    supportsTools: integer("supports_tools", { mode: "boolean" }),
    supportsVision: integer("supports_vision", { mode: "boolean" }),
    tagsJson: text("tags_json").notNull().default("[]"),
    enabled: bool("enabled"),
    source: text("source").notNull().default("manual"), // 'manual' | 'discovered' | 'import'
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("models_provider_model_idx").on(t.providerId, t.modelId),
    index("models_provider_idx").on(t.providerId),
  ],
);

export const modelCapabilities = sqliteTable(
  "model_capabilities",
  {
    id: id(),
    modelId: text("model_id")
      .notNull()
      .references(() => models.id, { onDelete: "cascade" }),
    capability: text("capability").notNull(),
    support: text("support").notNull().default("unknown"), // 'supported' | 'unsupported' | 'unknown'
  },
  (t) => [uniqueIndex("model_capabilities_idx").on(t.modelId, t.capability)],
);

/* ----------------------------------- agents ----------------------------------- */

export const agents = sqliteTable("agents", {
  id: id(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  systemInstructions: text("system_instructions").notNull().default(""),
  modelId: text("model_id").references(() => models.id, { onDelete: "set null" }),
  temperature: real("temperature").notNull().default(0.7),
  maxTokens: integer("max_tokens").notNull().default(2048),
  executionLimit: integer("execution_limit").notNull().default(10), // max loop iterations
  retryLimit: integer("retry_limit").notNull().default(2),
  memoryMode: text("memory_mode").notNull().default("session"), // 'none' | 'session' | 'persistent'
  contextMode: text("context_mode").notNull().default("manual"),
  outputFormat: text("output_format").notNull().default("text"), // 'text' | 'json'
  isExample: bool("is_example"),
  enabled: bool("enabled"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const agentTools = sqliteTable(
  "agent_tools",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    toolIntegrationId: text("tool_integration_id")
      .notNull()
      .references(() => toolIntegrations.id, { onDelete: "cascade" }),
    permission: text("permission").notNull().default("read"), // 'read' | 'write' | 'execute' | 'admin'
    requiresApproval: integer("requires_approval", { mode: "boolean" }).notNull().default(true),
  },
  (t) => [uniqueIndex("agent_tools_pk").on(t.agentId, t.toolIntegrationId)],
);

/* ---------------------------------- workflows ---------------------------------- */

export const workflows = sqliteTable("workflows", {
  id: id(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  tagsJson: text("tags_json").notNull().default("[]"),
  enabled: bool("enabled"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const workflowVersions = sqliteTable(
  "workflow_versions",
  {
    id: id(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    definitionJson: text("definition_json").notNull(), // full snapshot for reproducibility
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("workflow_versions_idx").on(t.workflowId, t.version)],
);

export const workflowNodes = sqliteTable(
  "workflow_nodes",
  {
    id: id(),
    workflowVersionId: text("workflow_version_id")
      .notNull()
      .references(() => workflowVersions.id, { onDelete: "cascade" }),
    nodeKey: text("node_key").notNull(),
    type: text("type").notNull(), // 'agent' | 'model' | 'tool' | 'condition' | 'approval' | 'input' | 'output'
    label: text("label").notNull().default(""),
    configJson: text("config_json").notNull().default("{}"),
    positionX: real("position_x").notNull().default(0),
    positionY: real("position_y").notNull().default(0),
  },
  (t) => [uniqueIndex("workflow_nodes_key_idx").on(t.workflowVersionId, t.nodeKey)],
);

export const workflowEdges = sqliteTable(
  "workflow_edges",
  {
    id: id(),
    workflowVersionId: text("workflow_version_id")
      .notNull()
      .references(() => workflowVersions.id, { onDelete: "cascade" }),
    sourceNodeKey: text("source_node_key").notNull(),
    targetNodeKey: text("target_node_key").notNull(),
    /** For conditional branches, e.g. 'true' | 'false'. Null = unconditional. */
    condition: text("condition"),
  },
  (t) => [index("workflow_edges_version_idx").on(t.workflowVersionId)],
);

export const workflowExecutions = sqliteTable(
  "workflow_executions",
  {
    id: id(),
    workflowId: text("workflow_id").references(() => workflows.id, { onDelete: "cascade" }),
    workflowVersionId: text("workflow_version_id")
      .references(() => workflowVersions.id),
    status: text("status").notNull().default("pending"), // pending|running|awaiting_approval|success|failed|cancelled
    inputJson: text("input_json").notNull().default("{}"),
    outputJson: text("output_json"),
    error: text("error"),
    triggeredBy: text("triggered_by").notNull().default("manual"),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
    createdAt: createdAt(),
  },
  (t) => [index("workflow_executions_wf_idx").on(t.workflowId, t.createdAt)],
);

/* ----------------------------- tasks & executions ----------------------------- */

export const tasks = sqliteTable("tasks", {
  id: id(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  status: text("status").notNull().default("pending"),
  projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const taskExecutions = sqliteTable("task_executions", {
  id: id(),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("pending"),
  inputJson: text("input_json").notNull().default("{}"),
  outputJson: text("output_json"),
  error: text("error"),
  startedAt: integer("started_at"),
  finishedAt: integer("finished_at"),
  createdAt: createdAt(),
});

export const agentExecutions = sqliteTable(
  "agent_executions",
  {
    id: id(),
    agentId: text("agent_id").references(() => agents.id, { onDelete: "set null" }),
    workflowExecutionId: text("workflow_execution_id").references(() => workflowExecutions.id, {
      onDelete: "set null",
    }),
    status: text("status").notNull().default("pending"),
    input: text("input").notNull().default(""),
    output: text("output"),
    error: text("error"),
    toolCalls: integer("tool_calls").notNull().default(0),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    totalTokens: integer("total_tokens"),
    estimatedCostUsd: real("estimated_cost_usd"),
    latencyMs: integer("latency_ms"),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
    createdAt: createdAt(),
  },
  (t) => [index("agent_executions_agent_idx").on(t.agentId, t.createdAt)],
);

export const agentMessages = sqliteTable(
  "agent_messages",
  {
    id: id(),
    workflowExecutionId: text("workflow_execution_id").references(() => workflowExecutions.id, {
      onDelete: "cascade",
    }),
    agentExecutionId: text("agent_execution_id").references(() => agentExecutions.id, {
      onDelete: "cascade",
    }),
    role: text("role").notNull(), // 'system' | 'user' | 'assistant' | 'tool' | 'message'
    agentName: text("agent_name"),
    content: text("content").notNull(),
    metaJson: text("meta_json").notNull().default("{}"),
    createdAt: createdAt(),
  },
  (t) => [index("agent_messages_exec_idx").on(t.workflowExecutionId, t.createdAt)],
);

/* ------------------------------- model requests -------------------------------- */

export const modelRequests = sqliteTable(
  "model_requests",
  {
    id: id(),
    providerId: text("provider_id").references(() => providers.id, { onDelete: "set null" }),
    modelRowId: text("model_row_id").references(() => models.id, { onDelete: "set null" }),
    modelId: text("model_id").notNull(), // as sent to provider
    agentExecutionId: text("agent_execution_id").references(() => agentExecutions.id, {
      onDelete: "set null",
    }),
    workflowExecutionId: text("workflow_execution_id").references(() => workflowExecutions.id, {
      onDelete: "set null",
    }),
    status: text("status").notNull(), // 'success' | 'error'
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    totalTokens: integer("total_tokens"),
    estimatedCostUsd: real("estimated_cost_usd"),
    costIsEstimated: integer("cost_is_estimated", { mode: "boolean" }).notNull().default(true),
    latencyMs: integer("latency_ms"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"), // redacted before insert
    createdAt: createdAt(),
  },
  (t) => [
    index("model_requests_provider_idx").on(t.providerId, t.createdAt),
    index("model_requests_model_idx").on(t.modelRowId, t.createdAt),
  ],
);

export const usageRecords = sqliteTable(
  "usage_records",
  {
    id: id(),
    providerId: text("provider_id").references(() => providers.id, { onDelete: "set null" }),
    modelRowId: text("model_row_id").references(() => models.id, { onDelete: "set null" }),
    agentId: text("agent_id").references(() => agents.id, { onDelete: "set null" }),
    workflowExecutionId: text("workflow_execution_id").references(() => workflowExecutions.id, {
      onDelete: "set null",
    }),
    modelRequestId: text("model_request_id").references(() => modelRequests.id, { onDelete: "cascade" }),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    totalTokens: integer("total_tokens"),
    estimatedCostUsd: real("estimated_cost_usd"),
    latencyMs: integer("latency_ms"),
    createdAt: createdAt(),
  },
  (t) => [index("usage_records_created_idx").on(t.createdAt)],
);

/* --------------------------------- benchmarks --------------------------------- */

export const benchmarkSuites = sqliteTable("benchmark_suites", {
  id: id(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const benchmarkCases = sqliteTable(
  "benchmark_cases",
  {
    id: id(),
    suiteId: text("suite_id")
      .notNull()
      .references(() => benchmarkSuites.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    prompt: text("prompt").notNull(),
    /** Optional deterministic check: substring the output must contain. */
    expectedSubstring: text("expected_substring"),
    /** Optional regex the output must match. */
    expectedRegex: text("expected_regex"),
    createdAt: createdAt(),
  },
  (t) => [index("benchmark_cases_suite_idx").on(t.suiteId)],
);

export const benchmarkRuns = sqliteTable(
  "benchmark_runs",
  {
    id: id(),
    suiteId: text("suite_id")
      .notNull()
      .references(() => benchmarkSuites.id, { onDelete: "cascade" }),
    modelRowIdsJson: text("model_row_ids_json").notNull().default("[]"),
    status: text("status").notNull().default("pending"),
    repeatCount: integer("repeat_count").notNull().default(1),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
    createdAt: createdAt(),
  },
  (t) => [index("benchmark_runs_suite_idx").on(t.suiteId, t.createdAt)],
);

export const benchmarkResults = sqliteTable(
  "benchmark_results",
  {
    id: id(),
    runId: text("run_id")
      .notNull()
      .references(() => benchmarkRuns.id, { onDelete: "cascade" }),
    caseId: text("case_id")
      .notNull()
      .references(() => benchmarkCases.id, { onDelete: "cascade" }),
    iteration: integer("iteration").notNull().default(1),
    modelRowId: text("model_row_id")
      .notNull()
      .references(() => models.id, { onDelete: "cascade" }),
    output: text("output"),
    passed: integer("passed", { mode: "boolean" }), // null = no deterministic check configured
    latencyMs: integer("latency_ms"),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    totalTokens: integer("total_tokens"),
    estimatedCostUsd: real("estimated_cost_usd"),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [index("benchmark_results_run_idx").on(t.runId)],
);

/* ---------------------------------- context ----------------------------------- */

export const projects = sqliteTable("projects", {
  id: id(),
  name: text("name").notNull(),
  rootPath: text("root_path"),
  metadataJson: text("metadata_json").notNull().default("{}"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const contextDocuments = sqliteTable(
  "context_documents",
  {
    id: id(),
    scope: text("scope").notNull().default("global"), // 'global' | 'project' | 'agent'
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    agentId: text("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    content: text("content").notNull(),
    mimeType: text("mime_type").notNull().default("text/markdown"),
    tagsJson: text("tags_json").notNull().default("[]"),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("context_documents_scope_idx").on(t.scope, t.projectId, t.agentId)],
);

export const memoryEntries = sqliteTable(
  "memory_entries",
  {
    id: id(),
    scope: text("scope").notNull().default("global"), // 'global' | 'project' | 'agent'
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    agentId: text("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    source: text("source").notNull().default("manual"), // 'manual' | 'agent'
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("memory_entries_scope_idx").on(t.scope, t.projectId, t.agentId, t.createdAt)],
);

/* ----------------------------------- tools ----------------------------------- */

export const toolIntegrations = sqliteTable("tool_integrations", {
  id: id(),
  name: text("name").notNull().unique(),
  type: text("type").notNull(), // 'http' | 'filesystem' | 'terminal' | 'git' | 'mcp' | 'custom'
  description: text("description").notNull().default(""),
  inputSchemaJson: text("input_schema_json").notNull().default("{\"type\":\"object\",\"properties\":{}}"),
  outputSchemaJson: text("output_schema_json").notNull().default("{\"type\":\"object\",\"properties\":{}}"),
  configJson: text("config_json").notNull().default("{}"),
  permission: text("permission").notNull().default("read-only"), // 'read-only' | 'standard' | 'dangerous'
  requiresApproval: integer("requires_approval", { mode: "boolean" }).notNull().default(true),
  timeoutMs: integer("timeout_ms").notNull().default(30_000),
  enabled: bool("enabled"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const toolExecutionLogs = sqliteTable(
  "tool_execution_logs",
  {
    id: id(),
    toolIntegrationId: text("tool_integration_id").references(() => toolIntegrations.id, {
      onDelete: "set null",
    }),
    agentExecutionId: text("agent_execution_id").references(() => agentExecutions.id, {
      onDelete: "set null",
    }),
    status: text("status").notNull(), // 'success' | 'error' | 'denied' | 'awaiting_approval'
    inputJson: text("input_json").notNull().default("{}"),
    outputJson: text("output_json"),
    durationMs: integer("duration_ms"),
    approvedBy: text("approved_by"), // 'user' | 'policy' | null
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [index("tool_execution_logs_created_idx").on(t.createdAt)],
);

/* ---------------------------------- opencode ---------------------------------- */

export const opencodeConnections = sqliteTable("opencode_connections", {
  id: id(),
  name: text("name").notNull(),
  baseUrl: text("base_url").notNull(),
  enabled: bool("enabled"),
  connectionStatus: text("connection_status").notNull().default("untested"),
  lastTestedAt: integer("last_tested_at"),
  lastError: text("last_error"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/* ----------------------------------- arena ----------------------------------- */

export const arenaSessions = sqliteTable("arena_sessions", {
  id: id(),
  prompt: text("prompt").notNull(),
  configJson: text("config_json").notNull().default("{}"),
  resultsJson: text("results_json").notNull().default("[]"),
  createdAt: createdAt(),
});

/* ------------------------------- settings & audit ------------------------------ */

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull(),
  updatedAt: updatedAt(),
});

export const auditLogs = sqliteTable(
  "audit_logs",
  {
    id: id(),
    actor: text("actor").notNull().default("user"), // 'user' | 'system'
    action: text("action").notNull(),
    target: text("target").notNull(),
    detailsJson: text("details_json").notNull().default("{}"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_logs_created_idx").on(t.createdAt)],
);

/* --------------------------------- relations ---------------------------------- */

export const providersRelations = relations(providers, ({ one, many }) => ({
  credential: one(providerCredentialsMetadata, {
    fields: [providers.id],
    references: [providerCredentialsMetadata.providerId],
  }),
  models: many(models),
}));

export const modelsRelations = relations(models, ({ one, many }) => ({
  provider: one(providers, { fields: [models.providerId], references: [providers.id] }),
  capabilities: many(modelCapabilities),
}));

export const agentsRelations = relations(agents, ({ one, many }) => ({
  model: one(models, { fields: [agents.modelId], references: [models.id] }),
  tools: many(agentTools),
}));

export const workflowsRelations = relations(workflows, ({ many }) => ({
  versions: many(workflowVersions),
  executions: many(workflowExecutions),
}));
