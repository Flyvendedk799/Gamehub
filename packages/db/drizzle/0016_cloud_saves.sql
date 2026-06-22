-- Engine Evolution P10b: per-user cloud-save key-value store (cross-device game
-- saves). Additive — applied via psql at deploy (NOT drizzle-kit).
--
-- A cloud save is scoped to (authenticated user, project, key). Any logged-in
-- user may save progress for any game they play — there is NO ownership
-- requirement on the project. The composite PK enforces one row per
-- (user, project, key) and backs the upsert + per-key/per-project clear paths.
CREATE TABLE IF NOT EXISTS cloud_saves (
  user_id text NOT NULL,
  project_id text NOT NULL,
  save_key text NOT NULL,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, project_id, save_key)
);
