/**
 * Phase 5.4 — playtest predicate evaluator tests.
 *
 * The headline case: an inverted-axis trace (player moves -x when it
 * should move +x) must FAIL the `playerPos.x increased` predicate
 * DETERMINISTICALLY — no LLM, no flake. This is the gate the deferred
 * boot-and-repair loop (#1.6) will consume.
 */
import { describe, expect, it } from 'vitest';
import {
  type PlaytestPredicate,
  type PlaytestTrace,
  evaluatePredicate,
  parsePlaytestPredicate,
  resolvePath,
  scorePlaytest,
} from './playtest-score';

/** Correct topdown-arcade trace: pressing D moves the player toward +x. */
const CORRECT_TRACE: PlaytestTrace = {
  baseline: { playerPos: { x: 100, y: 100 }, score: 0 },
  frames: [
    { stepIndex: 0, snapshot: { playerPos: { x: 130, y: 100 }, score: 0 } }, // D held → x rose
  ],
};

/** Inverted-axis trace: pressing D moved the player toward -x (the
 *  c44763af sign-error class). */
const INVERTED_TRACE: PlaytestTrace = {
  baseline: { playerPos: { x: 100, y: 100 }, score: 0 },
  frames: [
    { stepIndex: 0, snapshot: { playerPos: { x: 70, y: 100 }, score: 0 } }, // D held → x FELL
  ],
};

const X_INCREASED: PlaytestPredicate = {
  field: 'playerPos.x',
  op: 'increased',
  frame: 'final',
  against: 'baseline',
  label: 'pressing D moves player +x',
};

describe('evaluatePredicate — inverted-axis sign error', () => {
  it('PASSES the "playerPos.x increased" predicate on a correct trace', () => {
    const r = evaluatePredicate(CORRECT_TRACE, X_INCREASED);
    expect(r.pass).toBe(true);
    expect(r.observed).toBe(130);
    expect(r.baseline).toBe(100);
  });

  it('FAILS the "playerPos.x increased" predicate on an inverted trace (deterministic)', () => {
    const r = evaluatePredicate(INVERTED_TRACE, X_INCREASED);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/did NOT increase/);
    // Deterministic: re-running yields the identical verdict.
    expect(evaluatePredicate(INVERTED_TRACE, X_INCREASED).pass).toBe(false);
  });

  it("the inverted trace would PASS a 'decreased' predicate (confirms the delta sign)", () => {
    const r = evaluatePredicate(INVERTED_TRACE, { ...X_INCREASED, op: 'decreased' });
    expect(r.pass).toBe(true);
  });
});

describe('evaluatePredicate — operators', () => {
  const trace: PlaytestTrace = {
    baseline: { playerPos: { x: 0, y: 0 }, score: 0, hp: 100, name: 'hero' },
    frames: [
      { stepIndex: 0, snapshot: { playerPos: { x: 0, y: -40 }, score: 10, hp: 100, name: 'hero' } },
    ],
  };

  it('decreased: y fell (north / up the screen)', () => {
    expect(evaluatePredicate(trace, { field: 'playerPos.y', op: 'decreased' }).pass).toBe(true);
  });
  it('increased: score rose', () => {
    expect(evaluatePredicate(trace, { field: 'score', op: 'increased' }).pass).toBe(true);
  });
  it('unchanged: hp stable across the step', () => {
    expect(evaluatePredicate(trace, { field: 'hp', op: 'unchanged' }).pass).toBe(true);
  });
  it('changed: x did NOT change → unchanged passes, changed fails', () => {
    expect(evaluatePredicate(trace, { field: 'playerPos.x', op: 'changed' }).pass).toBe(false);
    expect(evaluatePredicate(trace, { field: 'playerPos.x', op: 'unchanged' }).pass).toBe(true);
  });
  it('eq: numeric and string equality', () => {
    expect(evaluatePredicate(trace, { field: 'score', op: 'eq', value: 10 }).pass).toBe(true);
    expect(evaluatePredicate(trace, { field: 'hp', op: 'gt', value: 50 }).pass).toBe(true);
    expect(evaluatePredicate(trace, { field: 'hp', op: 'lt', value: 50 }).pass).toBe(false);
  });
  it('epsilon: jitter below epsilon does not count as increased', () => {
    const jitter: PlaytestTrace = {
      baseline: { v: 1.0 },
      frames: [{ stepIndex: 0, snapshot: { v: 1.0001 } }],
    };
    expect(evaluatePredicate(jitter, { field: 'v', op: 'increased', epsilon: 0.01 }).pass).toBe(
      false,
    );
    expect(evaluatePredicate(jitter, { field: 'v', op: 'increased' }).pass).toBe(true);
  });
});

describe('evaluatePredicate — total / defensive (never throws)', () => {
  const trace: PlaytestTrace = {
    baseline: { playerPos: { x: 0 } },
    frames: [{ stepIndex: 0, snapshot: { playerPos: { x: 5 } } }],
  };
  it('missing field is a deterministic FAIL, not a throw', () => {
    const r = evaluatePredicate(trace, { field: 'enemies.0.hp', op: 'decreased' });
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/missing/);
  });
  it('out-of-range frame index is a deterministic FAIL', () => {
    const r = evaluatePredicate(trace, {
      field: 'playerPos.x',
      op: 'increased',
      frame: { step: 9 },
    });
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/out of range/);
  });
  it('non-numeric value for gt is a FAIL', () => {
    const t: PlaytestTrace = {
      baseline: { v: 'x' },
      frames: [{ stepIndex: 0, snapshot: { v: 'x' } }],
    };
    expect(evaluatePredicate(t, { field: 'v', op: 'gt', value: 1 }).pass).toBe(false);
  });
});

describe('resolvePath', () => {
  it('resolves nested object + array paths', () => {
    expect(resolvePath({ a: { b: [1, 2, 3] } }, 'a.b.1')).toBe(2);
    expect(resolvePath({ a: { b: 5 } }, 'a.b')).toBe(5);
    expect(resolvePath({ a: 1 }, 'a.b.c')).toBeUndefined();
    expect(resolvePath(null, 'a')).toBeUndefined();
  });
});

describe('scorePlaytest', () => {
  it('aggregates: all-pass → pass; one-fail → fail', () => {
    const ok = scorePlaytest(CORRECT_TRACE, [
      X_INCREASED,
      { field: 'playerPos.y', op: 'unchanged' },
    ]);
    expect(ok.pass).toBe(true);
    expect(ok.failures).toBe(0);

    const bad = scorePlaytest(INVERTED_TRACE, [X_INCREASED]);
    expect(bad.pass).toBe(false);
    expect(bad.failures).toBe(1);
  });
});

describe('parsePlaytestPredicate', () => {
  it('parses a valid predicate', () => {
    const p = parsePlaytestPredicate({
      field: 'playerPos.x',
      op: 'increased',
      frame: { step: 0 },
      against: 'baseline',
      epsilon: 1,
    });
    expect(p.op).toBe('increased');
    expect(p.frame).toEqual({ step: 0 });
  });
  it('rejects a bad op', () => {
    expect(() => parsePlaytestPredicate({ field: 'x', op: 'wiggled' })).toThrow(/op must be/);
  });
  it('rejects eq/gt/lt without a value', () => {
    expect(() => parsePlaytestPredicate({ field: 'x', op: 'eq' })).toThrow(/requires a 'value'/);
  });
  it('rejects a bad frame ref', () => {
    expect(() => parsePlaytestPredicate({ field: 'x', op: 'increased', frame: 'middle' })).toThrow(
      /frame must be/,
    );
  });
});

describe('scorePlaytest — observed/substantiation (plan step 6)', () => {
  it('scorePlaytest reports observed = predicates whose field resolved (plan step 6)', () => {
    const trace: PlaytestTrace = {
      baseline: { score: 0 },
      frames: [{ stepIndex: 1, snapshot: { score: 5 } }],
    };
    const score = scorePlaytest(trace, [
      { field: 'score', op: 'increased' }, // present → observed
      { field: 'missingField', op: 'increased' }, // missing → NOT observed
    ]);
    expect(score.observed).toBe(1);
  });
});
