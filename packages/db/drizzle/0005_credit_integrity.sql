-- Credit integrity: DB-level primitives the reservation/refund credit model
-- and the worker transaction rely on. All DDL is additive + idempotent.

-- One reservation row per run: makes the enqueue-time RESERVE insert idempotent
-- under concurrent or retried POST /v1/projects/:id/generate calls.
CREATE UNIQUE INDEX IF NOT EXISTS "credit_ledger_reservation_key"
  ON "credit_ledger" ("run_id")
  WHERE "reason" = 'reservation';--> statement-breakpoint

-- One refund row per run: a failed run refunds exactly once even when both the
-- worker 'failed' handler (Redis path) and the in-process .catch (no-Redis path)
-- attempt to insert a refund.
CREATE UNIQUE INDEX IF NOT EXISTS "credit_ledger_refund_key"
  ON "credit_ledger" ("run_id")
  WHERE "reason" = 'refund';--> statement-breakpoint

-- Covering index for the per-user balance SUM(delta).
CREATE INDEX IF NOT EXISTS "credit_ledger_user_idx"
  ON "credit_ledger" ("user_id");--> statement-breakpoint

-- Enforce a dense, collision-free snapshot sequence per project. The unique
-- btree on these leading columns also serves every lookup the old non-unique
-- snapshots_project_seq_idx did, so that one is now redundant and dropped.
CREATE UNIQUE INDEX IF NOT EXISTS "snapshots_project_seq_key"
  ON "snapshots" ("project_id", "seq");--> statement-breakpoint

DROP INDEX IF EXISTS "snapshots_project_seq_idx";
