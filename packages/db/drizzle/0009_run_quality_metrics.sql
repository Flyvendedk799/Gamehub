-- Phase 5.6 — per-run quality telemetry. One row per completed generation,
-- written best-effort by the worker after the boot-and-repair loop settles. A
-- nightly job trends per-genre quality from these rows. All DDL is additive +
-- idempotent (IF NOT EXISTS) so `psql playforge -f` can be re-applied safely.
-- Applied directly via psql, NOT drizzle-kit migrate (the journal only tracks
-- 0000–0002; 0003+ are hand-applied — see 0007 / 0008).

-- run_id is the PK (one telemetry row per run) and cascade-deletes with the run.
-- juice_score (5.5) + runtime_booted (5.3) are nullable: a queue-down / no-port
-- run has no measured verdict. force_accept is true when the run shipped WITHOUT
-- a passing deterministic verdict (repair_exhausted / budget_exhausted).
CREATE TABLE IF NOT EXISTS "run_quality_metrics" (
  "run_id" uuid PRIMARY KEY NOT NULL REFERENCES "runs"("id") ON DELETE CASCADE,
  "genre" text,
  "force_accept" boolean DEFAULT false NOT NULL,
  "repair_rounds" integer DEFAULT 0 NOT NULL,
  "ship_reason" text NOT NULL,
  "playbook_pass" integer DEFAULT 0 NOT NULL,
  "playbook_total" integer DEFAULT 0 NOT NULL,
  "juice_score" numeric(12, 0),
  "runtime_booted" boolean,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

-- Nightly per-genre trend: filter by genre, scan by time.
CREATE INDEX IF NOT EXISTS "run_quality_metrics_genre_created_idx"
  ON "run_quality_metrics" ("genre", "created_at");
