-- Per-user subscription credentials (Claude Code + Google Antigravity) kept by
-- @flyvendedk799/ai-auth's PostgresCredentialStore.
--
-- Additive only — applied via psql at deploy (NOT drizzle-kit), same as 0016/0017. The API also
-- runs this idempotently on boot (services/api/src/ai-auth.ts), so a missed psql step degrades
-- to "works" rather than "500s on connect".
--
-- `key` is namespaced by ai-auth per account (user id) and provider; `payload` is the
-- AES-sealed credential (SecretBox), never plaintext; `meta` holds the small non-secret facts
-- (plan, expiry) so they can be read without opening the blob.
CREATE TABLE IF NOT EXISTS ai_auth_credentials (
  key        text PRIMARY KEY,
  payload    text NOT NULL,
  meta       jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
