CREATE TABLE `arena_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`prompt` text NOT NULL,
	`config_json` text DEFAULT '{}' NOT NULL,
	`results_json` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL
);
