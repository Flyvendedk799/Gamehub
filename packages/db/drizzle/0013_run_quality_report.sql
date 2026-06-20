-- Richer per-run telemetry: a structured build report (spec shape, tool/skill
-- histogram, invariant warnings, novelty path, tokens) stored as JSON so we can
-- learn from runs. Additive only — applied via psql at deploy (NOT drizzle-kit).
ALTER TABLE "run_quality_metrics" ADD COLUMN IF NOT EXISTS "report" jsonb;
