/**
 * Per-user cloud-save key-value store (Engine Evolution P10b — cross-device game
 * saves).
 *
 * A cloud save is scoped to (authenticated user, project, key). A logged-in user
 * reads/writes ONLY their own saves; there is NO ownership requirement on the
 * project — any logged-in user may save progress for any game they play. The
 * composite primary key `(user_id, project_id, save_key)` enforces one row per
 * scope and backs the upsert (`.onConflictDoUpdate`) + per-key / per-project
 * clear paths. `value` is opaque JSON (size-capped at the API boundary).
 *
 * `user_id` / `project_id` are `text` (not FK `uuid`) to keep the store
 * decoupled from the identity/project schema: saves are addressed by id strings
 * and never join back, so they carry no referential constraint.
 */
import { jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

export const cloudSaves = pgTable(
  'cloud_saves',
  {
    userId: text('user_id').notNull(),
    projectId: text('project_id').notNull(),
    saveKey: text('save_key').notNull(),
    value: jsonb('value').$type<unknown>().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.projectId, t.saveKey] }),
  }),
);
