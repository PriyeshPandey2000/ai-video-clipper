ALTER TABLE `clips` ADD `original_start_ms` integer;--> statement-breakpoint
ALTER TABLE `clips` ADD `original_end_ms` integer;--> statement-breakpoint
ALTER TABLE `clips` ADD `ai_rank` integer;--> statement-breakpoint
ALTER TABLE `clips` ADD `pipeline_version` text;--> statement-breakpoint
ALTER TABLE `clips` ADD `pipeline_hash` text;--> statement-breakpoint
ALTER TABLE `clips` ADD `ai_model` text;--> statement-breakpoint
ALTER TABLE `clips` ADD `content_type` text;--> statement-breakpoint
CREATE INDEX `clips_pipeline_hash_idx` ON `clips` (`pipeline_hash`);