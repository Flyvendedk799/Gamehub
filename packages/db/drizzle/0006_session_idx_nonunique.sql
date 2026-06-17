-- sessions_user_idx must NOT be unique: two near-simultaneous logins by the same
-- user can collide on (user_id, created_at) and 500 the second login. Replace the
-- unique index with a plain lookup index of the same name + columns.

DROP INDEX IF EXISTS "sessions_user_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_user_idx" ON "sessions" ("user_id","created_at");
