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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => ({
    projectCreatedIdx: index('runs_project_created_idx').on(t.projectId, t.createdAt),
    userCreatedIdx: index('runs_user_created_idx').on(t.userId, t.createdAt),
  }),
);
