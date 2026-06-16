ALTER TABLE "projects" ADD COLUMN "current_manifest_key" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "snapshot_manifest_key" text;