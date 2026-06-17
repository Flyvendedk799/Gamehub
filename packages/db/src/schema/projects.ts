/**
 * Projects, versions (snapshots), and files.
 *
 * A `project` is a user's game (the cloud promotion of the desktop `designs`
 * table). Each generation produces an immutable `snapshot` (≈ `design_snapshots`).
 * File trees are NOT stored inline — `snapshots.filesManifestKey` points at a
 * content-addressed `manifest.json` in object storage (see @playforge/storage),
 * so unchanged files dedupe across versions and **remix is a metadata-only copy**.
 */
import type { GameSpec } from '@playforge/shared';
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './identity';

export const engineKind = pgEnum('engine_kind', ['three', 'phaser']);
export const projectVisibility = pgEnum('project_visibility', ['private', 'unlisted', 'public']);
export const snapshotType = pgEnum('snapshot_type', [
  'initial',
  'edit',
  'fork',
  'remix',
  'revert',
]);

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    name: text('name').notNull().default('Untitled game'),
    engine: engineKind('engine'),
    // HEAD pointer. Nullable + no FK constraint here to avoid a cycle with
    // snapshots (which references projects); enforced in application logic.
    currentSnapshotId: uuid('current_snapshot_id'),
    gameSpec: jsonb('game_spec').$type<GameSpec>(),
    visibility: projectVisibility('visibility').notNull().default('private'),
    remixOfProjectId: uuid('remix_of_project_id'),
    remixOfSnapshotId: uuid('remix_of_snapshot_id'),
    thumbnailUrl: text('thumbnail_url'),
    /** Manifest key of the most recent completed generation for this project. */
    currentManifestKey: text('current_manifest_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    ownerUpdatedIdx: index('projects_owner_updated_idx').on(t.ownerId, t.updatedAt),
  }),
);

export const snapshots = pgTable(
  'snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    parentId: uuid('parent_id'),
    seq: integer('seq').notNull(),
    type: snapshotType('type').notNull(),
    prompt: text('prompt'),
    gameSpec: jsonb('game_spec').$type<GameSpec>(),
    engine: engineKind('engine'),
    engineVersion: text('engine_version'),
    tweakSchema: jsonb('tweak_schema').$type<unknown>(),
    /** Object-storage key of the content-addressed file manifest for this version. */
    filesManifestKey: text('files_manifest_key').notNull(),
    /** Content hash of the manifest (dedup + cache key). */
    filesHash: text('files_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // UNIQUE on (project_id, seq): guarantees a snapshot sequence is dense and
    // collision-free per project. A unique btree on these leading columns also
    // serves the same (project_id) / (project_id, seq) lookups the old
    // non-unique snapshots_project_seq_idx did, so that one is redundant and
    // dropped (see migration 0005) rather than kept alongside.
    projectSeqKey: uniqueIndex('snapshots_project_seq_key').on(t.projectId, t.seq),
  }),
);
