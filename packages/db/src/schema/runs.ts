/**
 * Chat transcript + generation runs (lifecycle + cost metering).
 *
 * `chatMessages` ports the desktop `chat_messages` table (per-project turn log,
 * `sessionId` partitions "new conversation"). `runs` is one agentic generation;
 * `continuation` holds the cache-aligned resume state from @playforge/shared's
 * continuation model (NOT a transcript replay), so a crashed worker resumes
 * cleanly. Token counts + cost feed the credit ledger.
 */
import type { AbortKind, ChatMessageKind } from '@playforge/shared';
import {
  bigint,
  bigserial,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { apiKeys, users } from './identity';
import { projects, snapshots } from './projects';

export const runStatus = pgEnum('run_status', [
  'queued',
  'running',
  'paused',
  'completed',
  'failed',
  'canceled',
]);

export const chatMessages = pgTable(
  'chat_messages',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    sessionId: integer('session_id').notNull().default(0),
    seq: integer('seq').notNull(),
    kind: text('kind').$type<ChatMessageKind>().notNull(),
    payload: jsonb('payload').$type<unknown>().notNull(),
    snapshotId: uuid('snapshot_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectSeqKey: uniqueIndex('chat_messages_project_seq_key').on(t.projectId, t.seq),
  }),
);

export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: runStatus('status').notNull().default('queued'),
    abortKind: text('abort_kind').$type<AbortKind>(),
    /** Cache-aligned resume state (decisionRecap, todoSnapshotSeq, lastUserBrief…). */
    continuation: jsonb('continuation').$type<unknown>(),
    /** Content-addressed manifest key for the game files produced by this run. */
    snapshotManifestKey: text('snapshot_manifest_key'),
    parentSnapshotId: uuid('parent_snapshot_id').references(() => snapshots.id, {
      onDelete: 'set null',
    }),
    byokKeyId: uuid('byok_key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    cachedInputTokens: bigint('cached_input_tokens', { mode: 'number' }).notNull().default(0),
    cacheCreationInputTokens: bigint('cache_creation_input_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    costUsd: numeric('cost_usd', { precision: 10, scale: 5 }).notNull().default('0'),
    creditsCharged: integer('credits_charged').notNull().default(0),
    /**
     * Active-generation timing for the social-outro card (docs/SOCIAL_OUTRO_PLAN.md).
     * `aiStartedAt`/`aiFinishedAt` bracket the agent loop; `aiRuntimeMs` is the
     * monotonic elapsed time of that loop (NOT createdAt→now / queue wait), summed
     * across completed snapshot runs for the project's headline "AI runtime".
     */
    aiStartedAt: timestamp('ai_started_at', { withTimezone: true }),
    aiFinishedAt: timestamp('ai_finished_at', { withTimezone: true }),
    aiRuntimeMs: integer('ai_runtime_ms').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => ({
    projectCreatedIdx: index('runs_project_created_idx').on(t.projectId, t.createdAt),
    userCreatedIdx: index('runs_user_created_idx').on(t.userId, t.createdAt),
  }),
);

/**
 * Durable build-feed event log. Every event the generation pipeline streams to
 * the browser (tool calls, assistant narration, the declared spec, the terminal
 * run_complete/error/paused) is appended here with a per-run `seq`, so the
 * builder log SURVIVES a page refresh and an API restart.
 *
 * Before this table the feed lived only in the (in-memory / Redis-Streams) bus:
 * on ServerHoster the API runs the bus in-memory and restarts often, so a
 * refresh mid-build showed an empty feed even though the run continued. The SSE
 * relay now backfills from here first, then tails the bus live.
 *
 * Text deltas are coalesced per assistant turn before insert (one row per turn,
 * not one per token) so the log stays compact; the live stream still pushes raw
 * deltas for real-time typing. Rows are scoped to a project so they cascade away
 * with the project, and a run's history is removed when the run is.
 */
export const runEvents = pgTable(
  'run_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    event: jsonb('event').$type<unknown>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    runSeqKey: uniqueIndex('run_events_run_seq_key').on(t.runId, t.seq),
  }),
);
