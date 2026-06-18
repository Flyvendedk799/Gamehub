/**
 * Phase 5.6 — Postgres telemetry eval-source tests.
 *
 * The source aggregates `run_quality_metrics` rows into per-genre quality. We
 * inject a FAKE `QualityRowSource` (a frozen in-memory array) so the
 * aggregation is proven with no live Postgres / no drizzle.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  PostgresEvalSource,
  type QualityWindow,
  type RunQualityRow,
  aggregateGenreQuality,
} from './source-postgres';

function row(over: Partial<RunQualityRow> = {}): RunQualityRow {
  return {
    genre: 'topdown_arcade',
    forceAccept: false,
    repairRounds: 0,
    shipReason: 'passed',
    playbookPass: 4,
    playbookTotal: 4,
    juiceScore: 100,
    runtimeBooted: true,
    ...over,
  };
}

describe('aggregateGenreQuality', () => {
  it('rolls runs up per genre with pass-rate + force-accept-rate', () => {
    const agg = aggregateGenreQuality([
      row({ genre: 'fps', shipReason: 'passed', forceAccept: false }),
      row({ genre: 'fps', shipReason: 'repair_exhausted', forceAccept: true }),
      row({ genre: 'platformer', shipReason: 'passed', forceAccept: false }),
    ]);
    // Sorted by genre.
    expect(agg.map((a) => a.genre)).toEqual(['fps', 'platformer']);

    const fps = agg.find((a) => a.genre === 'fps')!;
    expect(fps.runs).toBe(2);
    expect(fps.passed).toBe(1);
    expect(fps.passRate).toBe(0.5);
    expect(fps.forceAccepted).toBe(1);
    expect(fps.forceAcceptRate).toBe(0.5);

    const plat = agg.find((a) => a.genre === 'platformer')!;
    expect(plat.runs).toBe(1);
    expect(plat.passRate).toBe(1);
    expect(plat.forceAcceptRate).toBe(0);
  });

  it('averages repair rounds + juice, and computes a boot rate over measured runs', () => {
    const agg = aggregateGenreQuality([
      row({ genre: 'fps', repairRounds: 0, juiceScore: 80, runtimeBooted: true }),
      row({ genre: 'fps', repairRounds: 2, juiceScore: 120, runtimeBooted: false }),
    ]);
    const fps = agg[0]!;
    expect(fps.avgRepairRounds).toBe(1);
    expect(fps.avgJuiceScore).toBe(100);
    expect(fps.bootRate).toBe(0.5);
  });

  it('treats unmeasured juice / boot as absent (null aggregate, not 0)', () => {
    const agg = aggregateGenreQuality([
      row({ genre: 'fps', juiceScore: null, runtimeBooted: null }),
      row({ genre: 'fps', juiceScore: null, runtimeBooted: null }),
    ]);
    const fps = agg[0]!;
    // No run measured juice or boot → the aggregate is null, NOT a misleading 0.
    expect(fps.avgJuiceScore).toBeNull();
    expect(fps.bootRate).toBeNull();
  });

  it('buckets genre-less runs under (none)', () => {
    const agg = aggregateGenreQuality([row({ genre: null })]);
    expect(agg[0]!.genre).toBe('(none)');
  });

  it('returns an empty array for no rows', () => {
    expect(aggregateGenreQuality([])).toEqual([]);
  });
});

describe('PostgresEvalSource', () => {
  it('threads the window to the injected query and aggregates the result', async () => {
    const window: QualityWindow = { genre: 'fps', since: new Date('2026-06-01T00:00:00Z') };
    const fetchRows = vi.fn(async (w: QualityWindow) => {
      expect(w).toEqual(window);
      return [
        row({ genre: 'fps', shipReason: 'passed' }),
        row({ genre: 'fps', shipReason: 'budget_exhausted', forceAccept: true }),
      ];
    });

    const source = new PostgresEvalSource(fetchRows);
    const agg = await source.genreQuality(window);

    expect(fetchRows).toHaveBeenCalledTimes(1);
    expect(agg).toHaveLength(1);
    expect(agg[0]!.genre).toBe('fps');
    expect(agg[0]!.runs).toBe(2);
    expect(agg[0]!.passRate).toBe(0.5);
    expect(agg[0]!.forceAcceptRate).toBe(0.5);
  });

  it('defaults to an empty window when none is passed', async () => {
    const fetchRows = vi.fn(async (w: QualityWindow) => {
      expect(w).toEqual({});
      return [];
    });
    const source = new PostgresEvalSource(fetchRows);
    expect(await source.genreQuality()).toEqual([]);
  });
});
