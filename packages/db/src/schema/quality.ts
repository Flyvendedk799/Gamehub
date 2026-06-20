/**
 * Phase 5.6 — per-run quality telemetry.
 *
 * One row per completed generation, written best-effort by the worker after the
 * boot-and-repair loop settles (`run-generation.ts`). It snapshots the
 * deterministic quality signals already in hand — never an LLM judgement — so a
 * nightly job can trend per-genre quality:
 *   - `shipReason` / `forceAccept`: WHY the run shipped, and whether it shipped
 *     WITHOUT a passing deterministic verdict (force-accept = a quality risk).
 *   - `repairRounds`: how many bounded boot-and-repair rounds (#1.6) it took.
 *   - `playbookPass` / `playbookTotal`: the genre playbook predicate pass-count
 *     for the shipped attempt (5.4 playtest-score).
 *   - `juiceScore` (5.5) + `runtimeBooted` (5.3): the OUTPUT-quality verdict.
 *
 * The `(genre, created_at)` index serves the nightly per-genre trend query
 * (pass-rate over a window). A telemetry write failure must NEVER fail a
 * generation — the caller wraps + logs it.
 */
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { runs } from './runs';

export const runQualityMetrics = pgTable(
  'run_quality_metrics',
  {
    runId: uuid('run_id')
      .primaryKey()
      .references(() => runs.id, { onDelete: 'cascade' }),
    /** Genre from the run's declared game spec, or null when none was declared. */
    genre: text('genre'),
    /** True when the run shipped WITHOUT a passing deterministic verdict
     *  (repair_exhausted / budget_exhausted) — i.e. force-accepted. */
    forceAccept: boolean('force_accept').notNull().default(false),
    /** Bounded boot-and-repair rounds run before shipping (#1.6). */
    repairRounds: integer('repair_rounds').notNull().default(0),
    /** Why the run shipped the attempt it shipped (#1.6 ShipReason). */
    shipReason: text('ship_reason').notNull(),
    /** Genre-playbook predicate pass-count for the shipped attempt (5.4). */
    playbookPass: integer('playbook_pass').notNull().default(0),
    /** Total genre-playbook predicates evaluated for the shipped attempt. */
    playbookTotal: integer('playbook_total').notNull().default(0),
    /** Measured juice/density score (5.5), or null when not measured. */
    juiceScore: numeric('juice_score', { precision: 12, scale: 0 }),
    /** Whether window.__game appeared on boot (5.3), or null when not measured. */
    runtimeBooted: boolean('runtime_booted'),
    /** Full structured per-run build report (spec shape, tool/skill histogram,
     *  invariant warnings, novelty path, tokens) — the richer telemetry we learn
     *  from. Mirrors the `[build-report]` log line. */
    report: jsonb('report').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Nightly per-genre trend: filter by genre, scan by time.
    genreCreatedIdx: index('run_quality_metrics_genre_created_idx').on(t.genre, t.createdAt),
  }),
);
