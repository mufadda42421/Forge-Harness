PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_workflow_executions` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text,
	`workflow_version_id` text,
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
INSERT INTO `__new_workflow_executions`("id", "workflow_id", "workflow_version_id", "status", "input_json", "output_json", "error", "triggered_by", "started_at", "finished_at", "created_at") SELECT "id", "workflow_id", "workflow_version_id", "status", "input_json", "output_json", "error", "triggered_by", "started_at", "finished_at", "created_at" FROM `workflow_executions`;--> statement-breakpoint
DROP TABLE `workflow_executions`;--> statement-breakpoint
ALTER TABLE `__new_workflow_executions` RENAME TO `workflow_executions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `workflow_executions_wf_idx` ON `workflow_executions` (`workflow_id`,`created_at`);