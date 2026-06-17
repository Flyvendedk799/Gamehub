/** Schema smoke tests — assert the tables, key columns, and enums exist with
 *  the expected SQL names. Cheap structural guard so an accidental rename or a
 *  dropped column surfaces in CI before it reaches a migration. */
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  chatMessages,
  creditLedger,
  engineKind,
  projects,
  publishedGames,
  runs,
  snapshots,
  users,
} from './index';

function columnNames(table: Parameters<typeof getTableConfig>[0]): string[] {
  return getTableConfig(table).columns.map((c) => c.name);
}

describe('schema', () => {
  it('users has the native-auth + profile columns', () => {
    const cfg = getTableConfig(users);
    expect(cfg.name).toBe('users');
    expect(columnNames(users)).toEqual(
      expect.arrayContaining(['id', 'email', 'password_hash', 'handle', 'display_name']),
    );
    // Clerk's external subject id was dropped when native auth landed.
    expect(columnNames(users)).not.toContain('clerk_user_id');
  });

  it('projects carries engine + game_spec + remix lineage', () => {
    expect(columnNames(projects)).toEqual(
      expect.arrayContaining([
        'id',
        'owner_id',
        'engine',
        'game_spec',
        'current_snapshot_id',
        'remix_of_project_id',
        'visibility',
      ]),
    );
  });

  it('snapshots point at a content-addressed manifest', () => {
    expect(columnNames(snapshots)).toEqual(
      expect.arrayContaining(['project_id', 'seq', 'files_manifest_key', 'files_hash', 'game_spec']),
    );
  });

  it('runs carry resume state + token metering', () => {
    expect(columnNames(runs)).toEqual(
      expect.arrayContaining([
        'status',
        'abort_kind',
        'continuation',
        'input_tokens',
        'output_tokens',
        'cost_usd',
        'credits_charged',
      ]),
    );
  });

  it('chat_messages enforce per-project sequence', () => {
    expect(columnNames(chatMessages)).toEqual(
      expect.arrayContaining(['project_id', 'session_id', 'seq', 'kind', 'payload']),
    );
  });

  it('published_games hold the bundle + denormalized social counters', () => {
    expect(columnNames(publishedGames)).toEqual(
      expect.arrayContaining(['publish_slug', 'bundle_key', 'status', 'play_count', 'rating_avg']),
    );
  });

  it('credit_ledger is append-only with a signed delta', () => {
    expect(columnNames(creditLedger)).toEqual(
      expect.arrayContaining(['user_id', 'delta', 'reason']),
    );
  });

  it('engine enum is web-only (three + phaser)', () => {
    expect(engineKind.enumValues).toEqual(['three', 'phaser']);
  });
});
