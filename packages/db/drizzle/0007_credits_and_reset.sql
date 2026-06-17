-- Phase 6 — credit purchase + password reset. All DDL is additive + idempotent
-- (IF NOT EXISTS) so it can be re-applied safely.

-- 6.2 — single-use password-reset tokens. Stores ONLY the SHA-256 hash of the
-- raw token (the raw value is mailed to the user and never persisted). A row is
-- consumed by setting used_at; a non-null used_at rejects replays. Cascade-deletes
-- with the user.
CREATE TABLE IF NOT EXISTS "password_reset_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token_hash" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

-- Unique single-row lookup by the presented token's hash.
CREATE UNIQUE INDEX IF NOT EXISTS "password_reset_tokens_hash_key"
  ON "password_reset_tokens" ("token_hash");--> statement-breakpoint

-- Lookup a user's outstanding reset tokens.
CREATE INDEX IF NOT EXISTS "password_reset_tokens_user_idx"
  ON "password_reset_tokens" ("user_id");--> statement-breakpoint

-- 6.1 — credit purchase reuses the EXISTING dormant partial-unique
-- "credit_ledger_user_event_key" on (user_id, stripe_event_id) WHERE
-- stripe_event_id IS NOT NULL for webhook idempotency. It was created in
-- migration 0000; this is a defensive idempotent re-assert so a fresh DB that
-- somehow lacks it still gets the constraint the purchase grant depends on.
CREATE UNIQUE INDEX IF NOT EXISTS "credit_ledger_user_event_key"
  ON "credit_ledger" ("user_id", "stripe_event_id")
  WHERE "stripe_event_id" IS NOT NULL;
