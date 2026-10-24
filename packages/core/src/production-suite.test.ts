import { describe, expect, it, vi } from 'vitest';
import { gardenProductionPlan } from '../../shared/src/testing/production-fixtures';
import { evaluatePredicate, parsePlaytestPredicate } from './eval/playtest-score';
import { type ScenarioTrace, runProductionSuite } from './production-suite';

describe('independent production scenarios', () => {
  const trace = (values: number[]): ScenarioTrace => ({
    hasGameContract: true,
    hasDebugContract: true,
    bootErrors: [],
    baselineSnapshot: { connections: 0 },
    steps: values.map((connections) => ({ snapshotAfter: { connections }, errors: [] })),
  });
  it('requires both interaction and recovery, with a fresh play invocation for each', async () => {
    const play = vi
      .fn()
      .mockResolvedValueOnce(trace([0, 1, 1]))
      .mockResolvedValueOnce(trace([1, 1, 0]));
    const result = await runProductionSuite(gardenProductionPlan(), play);
    expect(play).toHaveBeenCalledTimes(2);
    expect(result.verdict.pass).toBe(true);
    expect(result.verdict.score?.observed).toBe(3);
    expect(result.evidence.map((s) => s.status)).toEqual(['passed', 'passed']);
  });
  it('does not allow a passing core mechanic to mask broken recovery', async () => {
    const play = vi
      .fn()
      .mockResolvedValueOnce(trace([0, 1, 1]))
      .mockResolvedValueOnce(trace([1, 1, 1]));
    const result = await runProductionSuite(gardenProductionPlan(), play);
    expect(result.verdict.pass).toBe(false);
    expect(result.evidence[1]?.failures.join(' ')).toContain('Reset the composition');
    expect(play).toHaveBeenCalledTimes(2); // no lucky-pass retries
  });
  it('does not claim complete verification when only part of the suite is available', async () => {
    const result = await runProductionSuite(
      gardenProductionPlan(),
      vi
        .fn()
        .mockResolvedValueOnce(trace([0, 1, 1]))
        .mockResolvedValueOnce(null),
    );
    expect(result.verdict.pass).toBe(false);
    expect(result.verdict.noEvidence).toBe(true);
    expect(result.evidence[1]?.status).toBe('unavailable');
  });
  it('rejects missing contracts and truncated input traces', async () => {
    const result = await runProductionSuite(gardenProductionPlan(), async () => ({
      ...trace([1]),
      hasDebugContract: false,
    }));
    expect(result.verdict.pass).toBe(false);
    expect(result.verdict.fatalErrors.join(' ')).toContain('Incomplete input trace');
  });
});

describe('genre-independent state assertions', () => {
  it.each([
    ['narrative choice', 'chapter', 'arrival', 'forest'],
    ['puzzle solution', 'solved', false, true],
    ['builder placement', 'selection', 'empty', 'windmill'],
    ['rhythm transport', 'playing', false, true],
    ['racing lap', 'phase', 'countdown', 'racing'],
    ['exploration discovery', 'region', 'home', 'observatory'],
    ['sport possession', 'possession', 'home', 'away'],
    ['creative hybrid', 'weather', 'sunny', 'musical-rain'],
  ])('observes %s without inventing score or health', (_name, field, before, after) => {
    const trace = {
      baseline: { [field]: before },
      frames: [{ stepIndex: 0, snapshot: { [field]: after } }],
    };
    expect(
      evaluatePredicate(trace, parsePlaytestPredicate({ field, op: 'eq', value: after })).pass,
    ).toBe(true);
    expect(evaluatePredicate(trace, { field, op: 'changed' }).pass).toBe(true);
    expect(evaluatePredicate(trace, { field, op: 'unchanged' }).pass).toBe(false);
  });
  it('never coerces equality or accepts ordered string comparisons', () => {
    expect(() => parsePlaytestPredicate({ field: 'mode', op: 'gt', value: 'active' })).toThrow();
    expect(
      evaluatePredicate(
        { baseline: {}, frames: [{ stepIndex: 0, snapshot: { count: 1 } }] },
        { field: 'count', op: 'eq', value: '1' },
      ).pass,
    ).toBe(false);
  });
});
