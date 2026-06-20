/**
 * may9 Phase 9 — playtest playbook lookup tests.
 */
import { describe, expect, it } from 'vitest';
import { type PlaytestTrace, scorePlaytest } from './eval/playtest-score';
import { getPlaytestPlaybook, listSupportedGenres } from './playtest-playbooks';

describe('getPlaytestPlaybook', () => {
  it('returns the brawler playbook with the expected guard against c44763af sign error', () => {
    const pb = getPlaytestPlaybook('fighting');
    expect(pb).not.toBeNull();
    expect(pb?.genre).toBe('fighting');
    expect(pb?.steps.length).toBeGreaterThan(0);
    expect(pb?.watchFor.join(' ')).toMatch(/sign-error|reversed/i);
  });

  it('returns the FPS playbook with pointer-lock cooldown advice', () => {
    const pb = getPlaytestPlaybook('fps');
    expect(pb).not.toBeNull();
    expect(pb?.watchFor.join(' ').toLowerCase()).toContain('pointer-lock');
  });

  it('returns null for an un-bundled genre', () => {
    const pb = getPlaytestPlaybook('idle');
    expect(pb).toBeNull();
  });

  it('listSupportedGenres includes the bundled cases (original 6 + shmup/racing/rpg/roguelike/tps)', () => {
    const genres = listSupportedGenres();
    for (const g of [
      'platformer',
      'fighting',
      'fps',
      'puzzle',
      'topdown_arcade',
      'runner',
      'shmup',
      'racing',
      'rpg',
      'roguelike',
      'tps',
    ] as const) {
      expect(genres).toContain(g);
    }
  });

  it('every bundled playbook predicate is well-formed (parses without throwing)', () => {
    for (const genre of listSupportedGenres()) {
      const pb = getPlaytestPlaybook(genre);
      for (const step of pb?.steps ?? []) {
        for (const p of step.predicates ?? []) {
          // The evaluator requires a non-empty field + a valid op; a typo here
          // would silently make a playbook always-fail → force-accept churn.
          expect(typeof p.field).toBe('string');
          expect(p.field.length).toBeGreaterThan(0);
          expect(['increased', 'decreased', 'changed', 'unchanged', 'eq', 'gt', 'lt']).toContain(
            p.op,
          );
        }
      }
    }
  });
});

describe('playbook machine-checkable predicates (Phase 5.4)', () => {
  /** Gather every step predicate in a playbook (the harness flattens the
   *  per-step lists into one set against the run's trace). */
  function allPredicates(genre: 'topdown_arcade' | 'fighting' | 'shmup') {
    const pb = getPlaytestPlaybook(genre);
    return (pb?.steps ?? []).flatMap((s) => s.predicates ?? []);
  }

  it('a CORRECT topdown trace passes every WASD-delta predicate', () => {
    const trace: PlaytestTrace = {
      baseline: { playerPos: { x: 100, y: 100 } },
      frames: [
        { stepIndex: 0, snapshot: { playerPos: { x: 100, y: 70 } } }, // W → y down
        { stepIndex: 1, snapshot: { playerPos: { x: 100, y: 110 } } }, // S → y up
        { stepIndex: 2, snapshot: { playerPos: { x: 70, y: 110 } } }, // A → x left
        { stepIndex: 3, snapshot: { playerPos: { x: 110, y: 110 } } }, // D → x right
      ],
    };
    const score = scorePlaytest(trace, allPredicates('topdown_arcade'));
    expect(score.pass).toBe(true);
  });

  it('an INVERTED topdown trace (D moves -x) FAILS the playbook predicate deterministically', () => {
    const trace: PlaytestTrace = {
      baseline: { playerPos: { x: 100, y: 100 } },
      frames: [
        { stepIndex: 0, snapshot: { playerPos: { x: 100, y: 70 } } },
        { stepIndex: 1, snapshot: { playerPos: { x: 100, y: 110 } } },
        { stepIndex: 2, snapshot: { playerPos: { x: 70, y: 110 } } },
        { stepIndex: 3, snapshot: { playerPos: { x: 40, y: 110 } } }, // D → x FELL (sign error)
      ],
    };
    const score = scorePlaytest(trace, allPredicates('topdown_arcade'));
    expect(score.pass).toBe(false);
    expect(score.results.some((r) => !r.pass && /playerPos.x/.test(r.reason))).toBe(true);
  });

  it('a CORRECT shmup trace (firing raises score, ship moves) passes', () => {
    const trace: PlaytestTrace = {
      baseline: { score: 0, playerPos: { x: 270 } },
      frames: [
        { stepIndex: 0, snapshot: { score: 0, playerPos: { x: 270 } } }, // settle
        { stepIndex: 1, snapshot: { score: 0, playerPos: { x: 270 } } }, // fire (in flight)
        { stepIndex: 2, snapshot: { score: 100, playerPos: { x: 270 } } }, // hit → score rose
        { stepIndex: 3, snapshot: { score: 100, playerPos: { x: 200 } } }, // left
        { stepIndex: 4, snapshot: { score: 100, playerPos: { x: 260 } } }, // right
      ],
    };
    expect(scorePlaytest(trace, allPredicates('shmup')).pass).toBe(true);
  });

  it('the shmup playbook flags "bullets never hit enemies" (score stays 0) deterministically', () => {
    const trace: PlaytestTrace = {
      baseline: { score: 0, playerPos: { x: 270 } },
      frames: [
        { stepIndex: 0, snapshot: { score: 0, playerPos: { x: 270 } } },
        { stepIndex: 1, snapshot: { score: 0, playerPos: { x: 270 } } },
        { stepIndex: 2, snapshot: { score: 0, playerPos: { x: 270 } } }, // fired, but NO hit → score flat
        { stepIndex: 3, snapshot: { score: 0, playerPos: { x: 200 } } },
        { stepIndex: 4, snapshot: { score: 0, playerPos: { x: 260 } } },
      ],
    };
    const score = scorePlaytest(trace, allPredicates('shmup'));
    expect(score.pass).toBe(false);
    expect(score.results.some((r) => !r.pass && /score/.test(r.reason))).toBe(true);
  });

  it('the fighting playbook flags the c44763af sign-error class (D should move +x)', () => {
    const trace: PlaytestTrace = {
      baseline: { playerPos: { x: 100, y: 0 }, opponentHp: 100 },
      frames: [
        { stepIndex: 0, snapshot: { playerPos: { x: 70, y: 0 }, opponentHp: 100 } }, // D → x FELL
        { stepIndex: 1, snapshot: { playerPos: { x: 40, y: 0 }, opponentHp: 100 } },
        { stepIndex: 2, snapshot: { playerPos: { x: 40, y: 0 }, opponentHp: 100 } },
        { stepIndex: 3, snapshot: { playerPos: { x: 40, y: 0 }, opponentHp: 90 } },
      ],
    };
    const score = scorePlaytest(trace, allPredicates('fighting'));
    expect(score.pass).toBe(false);
  });
});
