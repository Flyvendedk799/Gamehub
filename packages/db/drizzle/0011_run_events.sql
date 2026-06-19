-- 0011_run_events — durable build-feed event log.
--
-- Persists every event the generation pipeline streams to the browser so the
-- builder log survives a refresh and an API restart (the bus is in-memory on
-- ServerHoster). The SSE relay backfills from here, then tails the bus live.
--
-- Repo convention (see project memory): migrations 0003+ are applied by
--   psql playforge -f packages/db/drizzle/0011_run_events.sql
-- and are written idempotently (IF NOT EXISTS), NOT via drizzle-kit migrate.

CREATE TABLE IF NOT EXISTS run_events (
  id          BIGSERIAL PRIMARY KEY,
  run_id      uuid        NOT NULL REFERENCES runs(id)     ON DELETE CASCADE,
  project_id  uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  seq         integer     NOT NULL,
  event       jsonb       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS run_events_run_seq_key ON run_events (run_id, seq);
