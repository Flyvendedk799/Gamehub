/**
 * Game Jam — the party mode.
 *
 * A `jam` is a live room addressed by a short, human-readable code. People join
 * from their phones (signed in OR as guests), answer prompt cards round by
 * round, and the collected answers compile into ONE brief that the normal
 * generation pipeline builds. Once built, the jam points at the resulting
 * `project` and run — the jam does NOT own game files, snapshots, or publishing;
 * it is purely the collaborative front half of an ordinary build.
 *
 * ## Guests are first-class
 * The host must be an authenticated user (they own the project the jam
 * produces, so it lands in their dashboard and their credits pay for it). Every
 * other seat may be a GUEST: `jam_players.user_id` is nullable and the seat is
 * authenticated by an opaque, hashed `player_token`. Handing a friend a
 * four-character code beats making them sign up mid-party, and the guest never
 * gains any capability beyond the room.
 *
 * ## Why the code column is what it is
 * `code` is UNIQUE only among LIVE rooms (partial unique index, see migration
 * 0017): codes are four characters from a 23-symbol alphabet, so they must be
 * recyclable once a room ends or the space exhausts. An ended jam keeps its row
 * (and its answers) for history while freeing the code for the next party.
 */
import type { JamConfig, JamPhase } from '@playforge/shared';
import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './identity';
import { projects } from './projects';
import { runs } from './runs';

export const jams = pgTable(
  'jams',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Short room code people type or read aloud. Unique among live rooms. */
    code: text('code').notNull(),
    /** The authenticated user who opened the room and owns the built project. */
    hostUserId: uuid('host_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Host's seat in `jam_players` — set right after the host row is inserted. */
    hostPlayerId: uuid('host_player_id'),
    /** Room lifecycle: lobby → prompt ⇄ reveal → building → ready → ended. */
    phase: text('phase').$type<JamPhase>().notNull().default('lobby'),
    /** Rounds/engine/timer, validated by JamConfig in @playforge/shared. */
    config: jsonb('config').$type<JamConfig>().notNull(),
    /** Deck card ids for this jam's rounds, in play order. */
    roundPromptIds: jsonb('round_prompt_ids').$type<string[]>().notNull(),
    /** 0-based index into `roundPromptIds`. */
    round: integer('round').notNull().default(0),
    /** When the current prompt round's timer expires; null when untimed. */
    deadlineAt: timestamp('deadline_at', { withTimezone: true }),
    /** Set when the host compiles the room into a build. */
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'set null' }),
    /**
     * Publish slug of the built game. Set when the host publishes from the room
     * so GUESTS — who have no account and cannot read /v1/projects/:id — still
     * get a playable link. Publishing stays an explicit host action.
     */
    playSlug: text('play_slug'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => ({
    // Partial unique on live rooms only, so a code frees up when a jam ends.
    // The predicate lives in the SQL migration (drizzle can express `.where()`
    // on an index; kept in lockstep with 0017).
    liveCodeKey: uniqueIndex('jams_live_code_key').on(t.code),
    hostIdx: index('jams_host_created_idx').on(t.hostUserId, t.createdAt),
  }),
);

export const jamPlayers = pgTable(
  'jam_players',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jamId: uuid('jam_id')
      .notNull()
      .references(() => jams.id, { onDelete: 'cascade' }),
    /** NULL for a guest who joined by code without an account. */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    /**
     * SHA-256 of the opaque seat token handed to this device. Only the hash is
     * stored — same posture as `password_reset_tokens` — so a database read
     * cannot impersonate a player.
     */
    tokenHash: text('token_hash').notNull(),
    name: text('name').notNull(),
    /** Palette id (`cyan`, `lime`, …) derived from the seat on join. */
    color: text('color').notNull(),
    /** Join order, 0-based. Drives color, roster order, and "P1/P2" labels. */
    seat: integer('seat').notNull(),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set when a player leaves; the row stays so their ideas keep attribution. */
    leftAt: timestamp('left_at', { withTimezone: true }),
  },
  (t) => ({
    tokenHashKey: uniqueIndex('jam_players_token_hash_key').on(t.tokenHash),
    // One row per seat number per room — makes the join insert race-safe.
    jamSeatKey: uniqueIndex('jam_players_jam_seat_key').on(t.jamId, t.seat),
    jamIdx: index('jam_players_jam_idx').on(t.jamId),
  }),
);

export const jamAnswers = pgTable(
  'jam_answers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jamId: uuid('jam_id')
      .notNull()
      .references(() => jams.id, { onDelete: 'cascade' }),
    playerId: uuid('player_id')
      .notNull()
      .references(() => jamPlayers.id, { onDelete: 'cascade' }),
    round: integer('round').notNull(),
    /** Deck card id this answers (`setting`, `coop`, `title`, …). */
    promptId: text('prompt_id').notNull(),
    text: text('text').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // One answer per player per round: re-submitting EDITS rather than stacking,
    // which is what a player expects when they fix a typo before the reveal.
    playerRoundKey: uniqueIndex('jam_answers_player_round_key').on(t.jamId, t.playerId, t.round),
    jamRoundIdx: index('jam_answers_jam_round_idx').on(t.jamId, t.round),
  }),
);

/**
 * Hype votes cast during the reveal. The composite PK makes a vote idempotent
 * and caps each voter at one vote per answer; the route additionally refuses
 * self-votes so the reveal ranking means something.
 */
export const jamVotes = pgTable(
  'jam_votes',
  {
    answerId: uuid('answer_id')
      .notNull()
      .references(() => jamAnswers.id, { onDelete: 'cascade' }),
    voterPlayerId: uuid('voter_player_id')
      .notNull()
      .references(() => jamPlayers.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.answerId, t.voterPlayerId] }),
    voterIdx: index('jam_votes_voter_idx').on(t.voterPlayerId),
  }),
);
