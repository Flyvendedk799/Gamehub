-- Phase 3.8 + 3.9 — Hub social: per-game leaderboards + creator follows. All
-- DDL is additive + idempotent (IF NOT EXISTS) so `psql playforge -f` can be
-- re-applied safely. Applied directly via psql, NOT drizzle-kit migrate (the
-- journal only tracks 0000–0002; 0003+ are hand-applied — see 0007).

-- 3.8 — per-game leaderboard scores. A game calls window.__game.reportScore(n);
-- the play page POSTs it to /v1/play/:slug/score, which inserts one row here.
-- user_id is null for an anonymous play. Both FKs cascade-delete. The submit
-- route rate-caps per salted-IP session so the board can't be spammed.
CREATE TABLE IF NOT EXISTS "game_scores" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "published_game_id" uuid NOT NULL REFERENCES "published_games"("id") ON DELETE CASCADE,
  "user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE,
  "score" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

-- Top-N-by-game: filter on the game, order by score desc.
CREATE INDEX IF NOT EXISTS "game_scores_game_score_idx"
  ON "game_scores" ("published_game_id", "score");--> statement-breakpoint

-- 3.9 — creator follows. A directed edge: follower_id follows followee_id. The
-- composite PK makes a follow idempotent (route uses ON CONFLICT DO NOTHING);
-- self-follows are rejected at the route. Both FKs cascade-delete with the user.
CREATE TABLE IF NOT EXISTS "follows" (
  "follower_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "followee_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "follows_follower_id_followee_id_pk" PRIMARY KEY ("follower_id", "followee_id")
);--> statement-breakpoint

-- Count a creator's followers / check isFollowing without scanning.
CREATE INDEX IF NOT EXISTS "follows_followee_idx"
  ON "follows" ("followee_id");
