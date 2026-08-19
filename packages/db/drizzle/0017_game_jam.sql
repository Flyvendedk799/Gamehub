-- Game Jam (party mode): a live room where 2+ people answer prompt cards from
-- their phones and the collected ideas compile into ONE build.
--
-- Additive only — applied via psql at deploy (NOT drizzle-kit), same as 0016.
--
-- Design notes worth keeping next to the DDL:
--   * jam_players.user_id is NULLABLE on purpose: guests join by code without an
--     account. The seat is authenticated by an opaque token; only its SHA-256
--     hash is stored (same posture as password_reset_tokens).
--   * jams.code is unique only among LIVE rooms. Four characters from a
--     23-symbol alphabet is a small space, so ended rooms must release their
--     code while keeping their row (and their ideas) for history.
--   * One answer per (jam, player, round): re-submitting EDITS, it does not
--     stack, which is what a player expects when fixing a typo pre-reveal.

CREATE TABLE IF NOT EXISTS jams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  host_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  host_player_id uuid,
  phase text NOT NULL DEFAULT 'lobby',
  config jsonb NOT NULL,
  round_prompt_ids jsonb NOT NULL,
  round integer NOT NULL DEFAULT 0,
  deadline_at timestamptz,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  run_id uuid REFERENCES runs(id) ON DELETE SET NULL,
  -- Publish slug of the built game, so guests (no account) get a playable link.
  play_slug text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);

-- Live rooms only: a code is reusable once the jam ends.
CREATE UNIQUE INDEX IF NOT EXISTS jams_live_code_key
  ON jams (code)
  WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS jams_host_created_idx ON jams (host_user_id, created_at);

CREATE TABLE IF NOT EXISTS jam_players (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  jam_id uuid NOT NULL REFERENCES jams(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  token_hash text NOT NULL,
  name text NOT NULL,
  color text NOT NULL,
  seat integer NOT NULL,
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS jam_players_token_hash_key ON jam_players (token_hash);
-- One row per seat per room — makes concurrent joins race-safe.
CREATE UNIQUE INDEX IF NOT EXISTS jam_players_jam_seat_key ON jam_players (jam_id, seat);
CREATE INDEX IF NOT EXISTS jam_players_jam_idx ON jam_players (jam_id);

CREATE TABLE IF NOT EXISTS jam_answers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  jam_id uuid NOT NULL REFERENCES jams(id) ON DELETE CASCADE,
  player_id uuid NOT NULL REFERENCES jam_players(id) ON DELETE CASCADE,
  round integer NOT NULL,
  prompt_id text NOT NULL,
  text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS jam_answers_player_round_key
  ON jam_answers (jam_id, player_id, round);
CREATE INDEX IF NOT EXISTS jam_answers_jam_round_idx ON jam_answers (jam_id, round);

CREATE TABLE IF NOT EXISTS jam_votes (
  answer_id uuid NOT NULL REFERENCES jam_answers(id) ON DELETE CASCADE,
  voter_player_id uuid NOT NULL REFERENCES jam_players(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (answer_id, voter_player_id)
);

CREATE INDEX IF NOT EXISTS jam_votes_voter_idx ON jam_votes (voter_player_id);
