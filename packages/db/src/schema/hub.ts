/**
 * Publishing + the community Hub.
 *
 * `publishedGames` is an immutable snapshot promoted to a public, CDN-served
 * bundle. Social objects (likes/ratings/comments), play analytics, remix
 * lineage, and moderation hang off it. Remix lineage also lives on
 * `projects.remixOf*`; `remixEdges` denormalizes the tree for "remixed N times".
 */
import type { GameSpec } from '@playforge/shared';
import {
  bigint,
  bigserial,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/** pgvector column — stored as float4[] in Postgres, surfaced as number[] in TS. */
const vector = customType<{ data: number[]; driverData: string; config: { dimensions?: number } }>({
  dataType(config) {
    return config?.dimensions !== undefined ? `vector(${config.dimensions})` : 'vector';
  },
  fromDriver(value: string): number[] {
    return value
      .replace(/^\[/, '')
      .replace(/\]$/, '')
      .split(',')
      .map(Number);
  },
  toDriver(value: number[]): string {
    return `[${value.join(',')}]`;
  },
});
import { users } from './identity';
import { projects, snapshots } from './projects';

export const publishedStatus = pgEnum('published_status', [
  'live',
  'unpublished',
  'removed_by_mod',
]);
export const moderationActionKind = pgEnum('moderation_action_kind', [
  'flag',
  'hide',
  'remove',
  'restore',
  'ban_user',
]);

export const publishedGames = pgTable(
  'published_games',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    snapshotId: uuid('snapshot_id')
      .references(() => snapshots.id, { onDelete: 'restrict' }),
    publishSlug: text('publish_slug').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    tags: text('tags').array(),
    /** Object-storage key of the built single-file HTML bundle. */
    bundleKey: text('bundle_key').notNull(),
    thumbnailUrl: text('thumbnail_url'),
    gameSpec: jsonb('game_spec').$type<GameSpec>(),
    status: publishedStatus('status').notNull().default('live'),
    /** 1536-dim embedding for pgvector cosine similarity search. Null until indexed. */
    embedding: vector('embedding', { dimensions: 1536 }),
    playCount: bigint('play_count', { mode: 'number' }).notNull().default(0),
    ratingAvg: numeric('rating_avg', { precision: 3, scale: 2 }).notNull().default('0'),
    ratingCount: integer('rating_count').notNull().default(0),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    slugKey: uniqueIndex('published_games_slug_key').on(t.publishSlug),
    statusPublishedIdx: index('published_games_status_published_idx').on(t.status, t.publishedAt),
  }),
);

export const likes = pgTable(
  'likes',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    publishedGameId: uuid('published_game_id')
      .notNull()
      .references(() => publishedGames.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.userId, t.publishedGameId] }) }),
);

export const ratings = pgTable(
  'ratings',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    publishedGameId: uuid('published_game_id')
      .notNull()
      .references(() => publishedGames.id, { onDelete: 'cascade' }),
    stars: smallint('stars').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.userId, t.publishedGameId] }) }),
);

export const commentsSocial = pgTable('comments_social', {
  id: uuid('id').primaryKey().defaultRandom(),
  publishedGameId: uuid('published_game_id')
    .notNull()
    .references(() => publishedGames.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  body: text('body').notNull(),
  parentCommentId: uuid('parent_comment_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const playEvents = pgTable(
  'play_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    publishedGameId: uuid('published_game_id')
      .notNull()
      .references(() => publishedGames.id, { onDelete: 'cascade' }),
    userId: uuid('user_id'),
    sessionHash: text('session_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ gameIdx: index('play_events_game_idx').on(t.publishedGameId, t.createdAt) }),
);

export const remixEdges = pgTable(
  'remix_edges',
  {
    ancestorProjectId: uuid('ancestor_project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    descendantProjectId: uuid('descendant_project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    depth: integer('depth').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.ancestorProjectId, t.descendantProjectId] }) }),
);

export const reports = pgTable('reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  reporterId: uuid('reporter_id').references(() => users.id, { onDelete: 'set null' }),
  targetType: text('target_type').notNull(),
  targetId: uuid('target_id').notNull(),
  reason: text('reason'),
  status: text('status').notNull().default('open'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const moderationActions = pgTable('moderation_actions', {
  id: uuid('id').primaryKey().defaultRandom(),
  targetType: text('target_type').notNull(),
  targetId: uuid('target_id').notNull(),
  action: moderationActionKind('action').notNull(),
  moderatorId: uuid('moderator_id').references(() => users.id, { onDelete: 'set null' }),
  reason: text('reason'),
  automated: boolean('automated').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
