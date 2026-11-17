CREATE TABLE `agent_executions` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text,
	`workflow_execution_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`input` text DEFAULT '' NOT NULL,
	`output` text,
	`error` text,
	`tool_calls` integer DEFAULT 0 NOT NULL,
	`prompt_tokens` integer,
	`completion_tokens` integer,
	`total_tokens` integer,
	`estimated_cost_usd` real,
	`latency_ms` integer,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`workflow_execution_id`) REFERENCES `workflow_executions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `agent_executions_agent_idx` ON `agent_executions` (`agent_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `agent_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_execution_id` text,
	`agent_execution_id` text,
	`role` text NOT NULL,
	`agent_name` text,
	`content` text NOT NULL,
	`meta_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workflow_execution_id`) REFERENCES `workflow_executions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_execution_id`) REFERENCES `agent_executions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_messages_exec_idx` ON `agent_messages` (`workflow_execution_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `agent_tools` (
	`agent_id` text NOT NULL,
	`tool_integration_id` text NOT NULL,
	`permission` text DEFAULT 'read' NOT NULL,
	`requires_approval` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tool_integration_id`) REFERENCES `tool_integrations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_tools_pk` ON `agent_tools` (`agent_id`,`tool_integration_id`);--> statement-breakpoint
CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`system_instructions` text DEFAULT '' NOT NULL,
	`model_id` text,
	`temperature` real DEFAULT 0.7 NOT NULL,
	`max_tokens` integer DEFAULT 2048 NOT NULL,
	`execution_limit` integer DEFAULT 10 NOT NULL,
	`retry_limit` integer DEFAULT 2 NOT NULL,
	`memory_mode` text DEFAULT 'session' NOT NULL,
	`context_mode` text DEFAULT 'manual' NOT NULL,
	`output_format` text DEFAULT 'text' NOT NULL,
	`is_example` integer DEFAULT false NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`model_id`) REFERENCES `models`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`actor` text DEFAULT 'user' NOT NULL,
	`action` text NOT NULL,
	`target` text NOT NULL,
	`details_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_logs_created_idx` ON `audit_logs` (`created_at`);--> statement-breakpoint
CREATE TABLE `benchmark_cases` (
	`id` text PRIMARY KEY NOT NULL,
	`suite_id` text NOT NULL,
	`name` text NOT NULL,
	`prompt` text NOT NULL,
	`expected_substring` text,
	`expected_regex` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`suite_id`) REFERENCES `benchmark_suites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `benchmark_cases_suite_idx` ON `benchmark_cases` (`suite_id`);--> statement-breakpoint
CREATE TABLE `benchmark_results` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`case_id` text NOT NULL,
	`iteration` integer DEFAULT 1 NOT NULL,
	`model_row_id` text NOT NULL,
	`output` text,
	`passed` integer,
	`latency_ms` integer,
	`prompt_tokens` integer,
	`completion_tokens` integer,
	`total_tokens` integer,
	`estimated_cost_usd` real,
	`error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `benchmark_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`case_id`) REFERENCES `benchmark_cases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`model_row_id`) REFERENCES `models`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `benchmark_results_run_idx` ON `benchmark_results` (`run_id`);--> statement-breakpoint
CREATE TABLE `benchmark_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`suite_id` text NOT NULL,
	`model_row_ids_json` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`repeat_count` integer DEFAULT 1 NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`suite_id`) REFERENCES `benchmark_suites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `benchmark_runs_suite_idx` ON `benchmark_runs` (`suite_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `benchmark_suites` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `context_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text DEFAULT 'global' NOT NULL,
	`project_id` text,
	`agent_id` text,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`mime_type` text DEFAULT 'text/markdown' NOT NULL,
	`tags_json` text DEFAULT '[]' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `context_documents_scope_idx` ON `context_documents` (`scope`,`project_id`,`agent_id`);--> statement-breakpoint
CREATE TABLE `credential_secrets` (
	`id` text PRIMARY KEY NOT NULL,
	`ref_type` text DEFAULT 'provider' NOT NULL,
	`ref_id` text NOT NULL,
	`ciphertext` text NOT NULL,
	`iv` text NOT NULL,
	`auth_tag` text NOT NULL,
	`algorithm` text DEFAULT 'aes-256-gcm' NOT NULL,
	`created_at` integer NOT NULL,
	`rotated_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credential_secrets_ref_idx` ON `credential_secrets` (`ref_type`,`ref_id`);--> statement-breakpoint
CREATE TABLE `memory_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text DEFAULT 'global' NOT NULL,
	`project_id` text,
	`agent_id` text,
	`content` text NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memory_entries_scope_idx` ON `memory_entries` (`scope`,`project_id`,`agent_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `model_capabilities` (
	`id` text PRIMARY KEY NOT NULL,
	`model_id` text NOT NULL,
	`capability` text NOT NULL,
	`support` text DEFAULT 'unknown' NOT NULL,
	FOREIGN KEY (`model_id`) REFERENCES `models`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `model_capabilities_idx` ON `model_capabilities` (`model_id`,`capability`);--> statement-breakpoint
CREATE TABLE `model_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text,
	`model_row_id` text,
	`model_id` text NOT NULL,
	`agent_execution_id` text,
	`workflow_execution_id` text,
	`status` text NOT NULL,
	`prompt_tokens` integer,
	`completion_tokens` integer,
	`total_tokens` integer,
	`estimated_cost_usd` real,
	`cost_is_estimated` integer DEFAULT true NOT NULL,
	`latency_ms` integer,
	`error_code` text,
	`error_message` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`model_row_id`) REFERENCES `models`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`agent_execution_id`) REFERENCES `agent_executions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`workflow_execution_id`) REFERENCES `workflow_executions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `model_requests_provider_idx` ON `model_requests` (`provider_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `model_requests_model_idx` ON `model_requests` (`model_row_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `models` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`model_id` text NOT NULL,
	`display_name` text NOT NULL,
	`context_window` integer,
	`max_output_tokens` integer,
	`input_cost_per_1m` real,
	`output_cost_per_1m` real,
	`cost_configured` integer DEFAULT false NOT NULL,
	`supports_streaming` integer,
	`supports_tools` integer,
	`supports_vision` integer,
	`tags_json` text DEFAULT '[]' NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `models_provider_model_idx` ON `models` (`provider_id`,`model_id`);--> statement-breakpoint
CREATE INDEX `models_provider_idx` ON `models` (`provider_id`);--> statement-breakpoint
CREATE TABLE `opencode_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`base_url` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`connection_status` text DEFAULT 'untested' NOT NULL,
	`last_tested_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`root_path` text,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `provider_credentials_metadata` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`auth_method` text NOT NULL,
	`key_hint` text,
	`storage_backend` text DEFAULT 'aes-256-gcm-file' NOT NULL,
	`rotated_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_credentials_metadata_provider_id_unique` ON `provider_credentials_metadata` (`provider_id`);--> statement-breakpoint
CREATE TABLE `providers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`identifier` text NOT NULL,
	`base_url` text NOT NULL,
	`compatibility` text NOT NULL,
	`auth_method` text DEFAULT 'bearer' NOT NULL,
	`custom_headers_json` text DEFAULT '{}' NOT NULL,
	`timeout_ms` integer DEFAULT 60000 NOT NULL,
	`max_retries` integer DEFAULT 2 NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`connection_status` text DEFAULT 'untested' NOT NULL,
	`last_tested_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `providers_identifier_unique` ON `providers` (`identifier`);--> statement-breakpoint
CREATE INDEX `providers_enabled_idx` ON `providers` (`enabled`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `task_executions` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`input_json` text DEFAULT '{}' NOT NULL,
	`output_json` text,
	`error` text,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`project_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `tool_execution_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`tool_integration_id` text,
	`agent_execution_id` text,
	`status` text NOT NULL,
	`input_json` text DEFAULT '{}' NOT NULL,
	`output_json` text,
	`duration_ms` integer,
	`approved_by` text,
	`error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tool_integration_id`) REFERENCES `tool_integrations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`agent_execution_id`) REFERENCES `agent_executions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `tool_execution_logs_created_idx` ON `tool_execution_logs` (`created_at`);--> statement-breakpoint
CREATE TABLE `tool_integrations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`input_schema_json` text DEFAULT '{"type":"object","properties":{}}' NOT NULL,
	`output_schema_json` text DEFAULT '{"type":"object","properties":{}}' NOT NULL,
	`config_json` text DEFAULT '{}' NOT NULL,
	`permission` text DEFAULT 'read-only' NOT NULL,
	`requires_approval` integer DEFAULT true NOT NULL,
	`timeout_ms` integer DEFAULT 30000 NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tool_integrations_name_unique` ON `tool_integrations` (`name`);--> statement-breakpoint
CREATE TABLE `usage_records` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text,
	`model_row_id` text,
	`agent_id` text,
	`workflow_execution_id` text,
	`model_request_id` text,
	`prompt_tokens` integer,
	`completion_tokens` integer,
	`total_tokens` integer,
	`estimated_cost_usd` real,
	`latency_ms` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`model_row_id`) REFERENCES `models`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`workflow_execution_id`) REFERENCES `workflow_executions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`model_request_id`) REFERENCES `model_requests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `usage_records_created_idx` ON `usage_records` (`created_at`);--> statement-breakpoint
CREATE TABLE `workflow_edges` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_version_id` text NOT NULL,
	`source_node_key` text NOT NULL,
	`target_node_key` text NOT NULL,
	`condition` text,
	FOREIGN KEY (`workflow_version_id`) REFERENCES `workflow_versions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workflow_edges_version_idx` ON `workflow_edges` (`workflow_version_id`);--> statement-breakpoint
CREATE TABLE `workflow_executions` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`workflow_version_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`input_json` text DEFAULT '{}' NOT NULL,
	`output_json` text,
	`error` text,
	`triggered_by` text DEFAULT 'manual' NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workflow_version_id`) REFERENCES `workflow_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `workflow_executions_wf_idx` ON `workflow_executions` (`workflow_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `workflow_nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_version_id` text NOT NULL,
	`node_key` text NOT NULL,
	`type` text NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`config_json` text DEFAULT '{}' NOT NULL,
	`position_x` real DEFAULT 0 NOT NULL,
	`position_y` real DEFAULT 0 NOT NULL,
	FOREIGN KEY (`workflow_version_id`) REFERENCES `workflow_versions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_nodes_key_idx` ON `workflow_nodes` (`workflow_version_id`,`node_key`);--> statement-breakpoint
CREATE TABLE `workflow_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`version` integer NOT NULL,
	`definition_json` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_versions_idx` ON `workflow_versions` (`workflow_id`,`version`);--> statement-breakpoint
CREATE TABLE `workflows` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`tags_json` text DEFAULT '[]' NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
