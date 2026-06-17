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

  it('listSupportedGenres includes the 6 bundled cases', () => {
    const genres = listSupportedGenres();
    expect(genres).toContain('platformer');
    expect(genres).toContain('fighting');
    expect(genres).toContain('fps');
    expect(genres).toContain('puzzle');
    expect(genres).toContain('topdown_arcade');
    expect(genres).toContain('runner');
  });
});

describe('playbook machine-checkable predicates (Phase 5.4)', () => {
  /** Gather every step predicate in a playbook (the harness flattens the
   *  per-step lists into one set against the run's trace). */
  function allPredicates(genre: 'topdown_arcade' | 'fighting') {
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
