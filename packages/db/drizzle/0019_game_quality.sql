ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS quality jsonb;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS last_verified_snapshot_id uuid;
