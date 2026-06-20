-- Social-outro AI-runtime timing on runs (docs/SOCIAL_OUTRO_PLAN.md).
-- Additive only — applied via psql at deploy (NOT drizzle-kit), so each ADD
-- COLUMN guards with IF NOT EXISTS for idempotent re-runs.
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "ai_started_at" timestamp with time zone;
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "ai_finished_at" timestamp with time zone;
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "ai_runtime_ms" integer NOT NULL DEFAULT 0;
