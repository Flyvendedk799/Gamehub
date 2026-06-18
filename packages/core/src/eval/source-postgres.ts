/**
 * Phase 5.6 — Postgres-backed eval data SOURCE for trended quality.
 *
 * The hermetic `pnpm eval:games` runner replays a single frozen
 * `RunObservation` per fixture (the recording source). This source is the OTHER
 * end of the same abstraction: it reads the per-run quality telemetry written by
 * the worker (`run_quality_metrics`, 5.6) and rolls it up into AGGREGATE,
 * trended quality — per-genre pass-rate over a window — for a nightly dashboard
 * / regression alarm.
 *
 * Like the eval runner, this module is PURE compute: it does NOT open a Postgres
 * connection or import drizzle. The caller injects a `QualityRowSource` — a thin
 * async function that returns the already-fetched `run_quality_metrics` rows (in
 * production a drizzle `select()`; in tests an in-memory array). This keeps the
 * core barrel free of better-sqlite3 / postgres-js AND makes the aggregation
 * unit-testable with no live DB.
 *
 * `forceAccept` / a non-`passed` `shipReason` is the quality SIGNAL the trend
 * watches: a rising per-genre force-accept rate means the deterministic gate is
 * letting more under-baked games through.
 */

/** One `run_quality_metrics` row, as the injected query returns it. A subset of
 *  the DB columns — only what the aggregation reads. `genre` is null when the
 *  run declared no spec. */
export interface RunQualityRow {
  genre: string | null;
  forceAccept: boolean;
  repairRounds: number;
  shipReason: string;
  playbookPass: number;
  playbookTotal: number;
  juiceScore: number | null;
  runtimeBooted: boolean | null;
}

/** Window selector for a trend query. Both bounds optional; the injected source
 *  decides how to apply them (a production drizzle source filters on
 *  `created_at`). */
export interface QualityWindow {
  /** Inclusive lower bound on created_at. */
  since?: Date;
  /** Inclusive upper bound on created_at. */
  until?: Date;
  /** Restrict to a single genre. */
  genre?: string;
}

/** Injected, side-effectful row fetch. Production: a drizzle `select()` against
 *  `run_quality_metrics` with the window applied; tests: a fake returning a
 *  frozen array. The aggregation never calls anything else. */
export type QualityRowSource = (window: QualityWindow) => Promise<ReadonlyArray<RunQualityRow>>;

/** Per-genre aggregate the trend dashboard renders. */
export interface GenreQualityAggregate {
  genre: string;
  /** Number of runs in the window for this genre. */
  runs: number;
  /** Runs that shipped with a passing deterministic verdict (shipReason === 'passed'). */
  passed: number;
  /** Fraction of runs that shipped passing, in [0, 1]. 0 when `runs` is 0. */
  passRate: number;
  /** Runs that shipped WITHOUT a passing deterministic verdict (force_accept). */
  forceAccepted: number;
  /** Fraction force-accepted, in [0, 1]. The trend regression watches this. */
  forceAcceptRate: number;
  /** Mean repair rounds across the window's runs (0 when `runs` is 0). */
  avgRepairRounds: number;
  /** Mean juiceScore across runs that measured one; null when none did. */
  avgJuiceScore: number | null;
  /** Fraction of runs whose artifact booted (window.__game appeared), over the
   *  runs that measured a boot verdict; null when none did. */
  bootRate: number | null;
}

const GENRELESS = '(none)' as const;

/**
 * The eval source abstraction the Postgres telemetry source implements. The
 * recording-replay path (eval-games.ts) is the per-fixture sibling; this is the
 * aggregate/trended path. Kept minimal: one method that returns per-genre
 * quality for a window.
 */
export interface EvalSource {
  /** Per-genre quality aggregate for the window, sorted by genre. */
  genreQuality(window?: QualityWindow): Promise<GenreQualityAggregate[]>;
}

/** Round to 4 dp to keep the dashboard / snapshot stable. */
function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/**
 * Pure aggregation: roll a flat list of telemetry rows up into one aggregate per
 * genre. Exposed for direct unit testing (no source, no DB).
 */
export function aggregateGenreQuality(rows: ReadonlyArray<RunQualityRow>): GenreQualityAggregate[] {
  interface Acc {
    runs: number;
    passed: number;
    forceAccepted: number;
    repairRoundsSum: number;
    juiceSum: number;
    juiceCount: number;
    bootMeasured: number;
    booted: number;
  }
  const byGenre = new Map<string, Acc>();
  for (const r of rows) {
    const key = r.genre ?? GENRELESS;
    const acc = byGenre.get(key) ?? {
      runs: 0,
      passed: 0,
      forceAccepted: 0,
      repairRoundsSum: 0,
      juiceSum: 0,
      juiceCount: 0,
      bootMeasured: 0,
      booted: 0,
    };
    acc.runs += 1;
    if (r.shipReason === 'passed') acc.passed += 1;
    if (r.forceAccept) acc.forceAccepted += 1;
    acc.repairRoundsSum += r.repairRounds;
    if (r.juiceScore !== null) {
      acc.juiceSum += r.juiceScore;
      acc.juiceCount += 1;
    }
    if (r.runtimeBooted !== null) {
      acc.bootMeasured += 1;
      if (r.runtimeBooted) acc.booted += 1;
    }
    byGenre.set(key, acc);
  }

  const out: GenreQualityAggregate[] = [];
  for (const [genre, acc] of byGenre) {
    out.push({
      genre,
      runs: acc.runs,
      passed: acc.passed,
      passRate: acc.runs === 0 ? 0 : round4(acc.passed / acc.runs),
      forceAccepted: acc.forceAccepted,
      forceAcceptRate: acc.runs === 0 ? 0 : round4(acc.forceAccepted / acc.runs),
      avgRepairRounds: acc.runs === 0 ? 0 : round4(acc.repairRoundsSum / acc.runs),
      avgJuiceScore: acc.juiceCount === 0 ? null : round4(acc.juiceSum / acc.juiceCount),
      bootRate: acc.bootMeasured === 0 ? null : round4(acc.booted / acc.bootMeasured),
    });
  }
  out.sort((a, b) => a.genre.localeCompare(b.genre));
  return out;
}

/**
 * Postgres telemetry eval source. Reads `run_quality_metrics` via the injected
 * `QualityRowSource` and aggregates per-genre. No DB driver is imported here —
 * the caller wires the concrete query.
 */
export class PostgresEvalSource implements EvalSource {
  constructor(private readonly fetchRows: QualityRowSource) {}

  async genreQuality(window: QualityWindow = {}): Promise<GenreQualityAggregate[]> {
    const rows = await this.fetchRows(window);
    return aggregateGenreQuality(rows);
  }
}
