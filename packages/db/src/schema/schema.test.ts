/** Schema smoke tests — assert the tables, key columns, and enums exist with
 *  the expected SQL names. Cheap structural guard so an accidental rename or a
 *  dropped column surfaces in CI before it reaches a migration. */
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  apiKeys,
  chatMessages,
  cloudSaves,
  creditLedger,
  engineKind,
  follows,
  gameScores,
  passwordResetTokens,
  projects,
  publishedGames,
  runQualityMetrics,
  runs,
  snapshots,
  users,
} from './index';

function columnNames(table: Parameters<typeof getTableConfig>[0]): string[] {
  return getTableConfig(table).columns.map((c) => c.name);
}

function indexNames(table: Parameters<typeof getTableConfig>[0]): string[] {
  return getTableConfig(table)
    .indexes.map((i) => i.config.name)
    .filter((n): n is string => n !== undefined);
}

describe('schema', () => {
  it('users has the native-auth + profile columns', () => {
    const cfg = getTableConfig(users);
    expect(cfg.name).toBe('users');
    expect(columnNames(users)).toEqual(
      expect.arrayContaining([
        'id',
        'email',
        'password_hash',
        'handle',
        'display_name',
        'default_provider',
        'default_model_id',
        'onboarding_completed_at',
      ]),
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
      expect.arrayContaining([
        'project_id',
        'seq',
        'files_manifest_key',
        'files_hash',
        'game_spec',
      ]),
    );
  });

  it('runs carry resume state + token metering + ai-runtime timing', () => {
    expect(columnNames(runs)).toEqual(
      expect.arrayContaining([
        'status',
        'abort_kind',
        'continuation',
        'input_tokens',
        'output_tokens',
        'cached_input_tokens',
        'cache_creation_input_tokens',
        'cost_usd',
        'credits_charged',
        // Social-outro AI-runtime timing (docs/SOCIAL_OUTRO_PLAN.md).
        'ai_started_at',
        'ai_finished_at',
        'ai_runtime_ms',
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

  it('api_keys stores one encrypted BYOK key per provider', () => {
    expect(columnNames(apiKeys)).toEqual(
      expect.arrayContaining(['user_id', 'provider', 'ciphertext', 'last4', 'updated_at']),
    );
    expect(indexNames(apiKeys)).toEqual(
      expect.arrayContaining(['api_keys_user_provider_key', 'api_keys_user_idx']),
    );
    const cfg = getTableConfig(apiKeys);
    const providerKey = cfg.indexes.find((i) => i.config.name === 'api_keys_user_provider_key');
    expect(providerKey?.config.unique).toBe(true);
  });

  it('credit_ledger carries the reservation/refund idempotency + balance indexes', () => {
    expect(indexNames(creditLedger)).toEqual(
      expect.arrayContaining([
        'credit_ledger_user_event_key',
        'credit_ledger_reservation_key',
        'credit_ledger_refund_key',
        'credit_ledger_user_idx',
      ]),
    );
  });

  it('snapshots enforce a unique (project_id, seq) sequence', () => {
    const cfg = getTableConfig(snapshots);
    const seqKey = cfg.indexes.find((i) => i.config.name === 'snapshots_project_seq_key');
    expect(seqKey).toBeDefined();
    expect(seqKey?.config.unique).toBe(true);
    // The redundant non-unique index was dropped in favour of the unique one.
    expect(indexNames(snapshots)).not.toContain('snapshots_project_seq_idx');
  });

  it('password_reset_tokens stores only a token hash + lifecycle timestamps', () => {
    const cfg = getTableConfig(passwordResetTokens);
    expect(cfg.name).toBe('password_reset_tokens');
    expect(columnNames(passwordResetTokens)).toEqual(
      expect.arrayContaining(['id', 'user_id', 'token_hash', 'expires_at', 'used_at']),
    );
    // The raw token is never persisted — only its hash.
    expect(columnNames(passwordResetTokens)).not.toContain('token');
  });

  it('password_reset_tokens has a unique hash index + a user lookup index', () => {
    expect(indexNames(passwordResetTokens)).toEqual(
      expect.arrayContaining(['password_reset_tokens_hash_key', 'password_reset_tokens_user_idx']),
    );
    const cfg = getTableConfig(passwordResetTokens);
    const hashKey = cfg.indexes.find((i) => i.config.name === 'password_reset_tokens_hash_key');
    expect(hashKey?.config.unique).toBe(true);
  });

  it('engine enum is web-only (three + phaser + canvas2d)', () => {
    expect(engineKind.enumValues).toEqual(['three', 'phaser', 'canvas2d']);
  });

  it('game_scores carries the leaderboard columns + a (game, score) index (Phase 3.8)', () => {
    const cfg = getTableConfig(gameScores);
    expect(cfg.name).toBe('game_scores');
    expect(columnNames(gameScores)).toEqual(
      expect.arrayContaining(['id', 'published_game_id', 'user_id', 'score', 'created_at']),
    );
    expect(indexNames(gameScores)).toContain('game_scores_game_score_idx');
  });

  it('run_quality_metrics holds the per-run quality telemetry + a (genre, created_at) index (Phase 5.6)', () => {
    const cfg = getTableConfig(runQualityMetrics);
    expect(cfg.name).toBe('run_quality_metrics');
    expect(columnNames(runQualityMetrics)).toEqual(
      expect.arrayContaining([
        'run_id',
        'genre',
        'force_accept',
        'repair_rounds',
        'ship_reason',
        'playbook_pass',
        'playbook_total',
        'juice_score',
        'runtime_booted',
        'created_at',
      ]),
    );
    // run_id is the PK (one telemetry row per run) and cascade-deletes with the run.
    // It's a single-column, column-level .primaryKey(), so it surfaces on the
    // column's `primary` flag — not in the table-level `primaryKeys` config
    // (which drizzle only populates for composite keys, cf. `follows`).
    expect(cfg.columns.find((c) => c.name === 'run_id')?.primary).toBe(true);
    expect(indexNames(runQualityMetrics)).toContain('run_quality_metrics_genre_created_idx');
  });

  it('follows is a directed edge with a unique (follower, followee) PK + followee index (Phase 3.9)', () => {
    const cfg = getTableConfig(follows);
    expect(cfg.name).toBe('follows');
    expect(columnNames(follows)).toEqual(
      expect.arrayContaining(['follower_id', 'followee_id', 'created_at']),
    );
    // Composite PK on (follower_id, followee_id) makes a follow idempotent.
    expect(cfg.primaryKeys[0]?.columns.map((c) => c.name)).toEqual(['follower_id', 'followee_id']);
    expect(indexNames(follows)).toContain('follows_followee_idx');
  });

  it('cloud_saves is a (user, project, key) KV store with a composite PK (P10b)', () => {
    const cfg = getTableConfig(cloudSaves);
    expect(cfg.name).toBe('cloud_saves');
    expect(columnNames(cloudSaves)).toEqual(
      expect.arrayContaining(['user_id', 'project_id', 'save_key', 'value', 'updated_at']),
    );
    // Composite PK on (user_id, project_id, save_key) scopes one row per save.
    expect(cfg.primaryKeys[0]?.columns.map((c) => c.name)).toEqual([
      'user_id',
      'project_id',
      'save_key',
    ]);
  });
});
