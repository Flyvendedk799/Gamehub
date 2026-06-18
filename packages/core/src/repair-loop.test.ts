/**
 * Phase 1.6 — bounded boot-and-repair loop (pure-core tests).
 *
 * These prove the deterministic BRAIN of the loop without a live browser-
 * worker: verdict construction from a trace + fatalErrors, the specific repair
 * instruction author, and the bounded-loop decision function (pass ships with
 * 0 rounds; a failing predicate triggers a repair; the ceiling ships
 * `repair_exhausted`; a non-completable spec ships `skipped_non_completable`;
 * budget exhaustion stops early). The worker integration test
 * (run-generation.test.ts) proves the same behaviour end-to-end against an
 * injected agent + stub browser-jobs port.
 */
import { describe, expect, it } from 'vitest';
import type { PlaytestPredicate, PlaytestTrace } from './eval/playtest-score.js';
import { selectGamePlaytestPlan } from './playtest-planner.js';
import { getPlaytestPlaybook } from './playtest-playbooks.js';
import {
  type AttemptObservation,
  DEFAULT_MAX_REPAIR_ROUNDS,
  MAX_REPAIR_ROUNDS_CEILING,
  type RepairLoopState,
  type RepairVerdict,
  buildRepairInstruction,
  buildRepairVerdict,
  decideRepairAction,
  resolveMaxRepairRounds,
  traceFromPlaytestResult,
} from './repair-loop.js';
import type { CompletabilitySpec } from './tools/assert-game-invariants.js';

/** All machine-checkable predicates a genre playbook ships, flattened. */
function predicatesFor(genre: 'topdown_arcade' | 'fighting'): PlaytestPredicate[] {
  const pb = getPlaytestPlaybook(genre);
  return (pb?.steps ?? []).flatMap((s) => s.predicates ?? []);
}

/** A completable spec for a genre with a real fail state. */
function completableSpec(genre: string): CompletabilitySpec {
  return { genre, winCondition: 'Reach the exit.', loseCondition: 'Health hits zero.' };
}

const PASSING_TOPDOWN_TRACE: PlaytestTrace = {
  baseline: { playerPos: { x: 100, y: 100 } },
  frames: [
    { stepIndex: 0, snapshot: { playerPos: { x: 100, y: 70 } } }, // W → y down
    { stepIndex: 1, snapshot: { playerPos: { x: 100, y: 110 } } }, // S → y up
    { stepIndex: 2, snapshot: { playerPos: { x: 70, y: 110 } } }, // A → x left
    { stepIndex: 3, snapshot: { playerPos: { x: 110, y: 110 } } }, // D → x right
  ],
};

/** The c44763af sign-error class: pressing D moves the player the wrong way. */
const INVERTED_TOPDOWN_TRACE: PlaytestTrace = {
  baseline: { playerPos: { x: 100, y: 100 } },
  frames: [
    { stepIndex: 0, snapshot: { playerPos: { x: 100, y: 70 } } },
    { stepIndex: 1, snapshot: { playerPos: { x: 100, y: 110 } } },
    { stepIndex: 2, snapshot: { playerPos: { x: 70, y: 110 } } },
    { stepIndex: 3, snapshot: { playerPos: { x: 40, y: 110 } } }, // D → x FELL (sign error)
  ],
};

function loopState(over: Partial<RepairLoopState> = {}): RepairLoopState {
  return {
    roundsRun: 0,
    maxRounds: DEFAULT_MAX_REPAIR_ROUNDS,
    budgetExhausted: false,
    ...over,
  };
}

describe('resolveMaxRepairRounds', () => {
  it('defaults to 2 and caps at the hard ceiling of 3', () => {
    expect(resolveMaxRepairRounds(undefined)).toBe(DEFAULT_MAX_REPAIR_ROUNDS);
    expect(DEFAULT_MAX_REPAIR_ROUNDS).toBe(2);
    expect(MAX_REPAIR_ROUNDS_CEILING).toBe(3);
    expect(resolveMaxRepairRounds(99)).toBe(3);
    expect(resolveMaxRepairRounds(1)).toBe(1);
    expect(resolveMaxRepairRounds(0)).toBe(0); // opt out
    expect(resolveMaxRepairRounds(-5)).toBe(DEFAULT_MAX_REPAIR_ROUNDS);
    expect(resolveMaxRepairRounds(Number.NaN)).toBe(DEFAULT_MAX_REPAIR_ROUNDS);
  });
});

describe('traceFromPlaytestResult', () => {
  it('maps baselineSnapshot + steps[*].snapshotAfter onto a 1:1 trace', () => {
    const trace = traceFromPlaytestResult({
      baselineSnapshot: { x: 0 },
      steps: [{ snapshotAfter: { x: 5 } }, { snapshotAfter: { x: 9 } }],
    });
    expect(trace.baseline).toEqual({ x: 0 });
    expect(trace.frames).toEqual([
      { stepIndex: 0, snapshot: { x: 5 } },
      { stepIndex: 1, snapshot: { x: 9 } },
    ]);
  });
});

describe('buildRepairVerdict', () => {
  it('passes a clean trace with no fatal errors', () => {
    const obs: AttemptObservation = { trace: PASSING_TOPDOWN_TRACE, fatalErrors: [] };
    const verdict = buildRepairVerdict(obs, predicatesFor('topdown_arcade'));
    expect(verdict.pass).toBe(true);
    expect(verdict.noEvidence).toBe(false);
    expect(verdict.score?.failures).toBe(0);
  });

  it('fails a sign-error trace and names the offending field', () => {
    const obs: AttemptObservation = { trace: INVERTED_TOPDOWN_TRACE, fatalErrors: [] };
    const verdict = buildRepairVerdict(obs, predicatesFor('topdown_arcade'));
    expect(verdict.pass).toBe(false);
    expect(verdict.score?.failures).toBeGreaterThan(0);
    expect(verdict.score?.results.some((r) => !r.pass && /playerPos\.x/.test(r.reason))).toBe(true);
  });

  it('treats a fatal boot error as a failure even with passing predicates', () => {
    const obs: AttemptObservation = {
      trace: PASSING_TOPDOWN_TRACE,
      fatalErrors: ['Uncaught TypeError: cannot read x of undefined'],
    };
    const verdict = buildRepairVerdict(obs, predicatesFor('topdown_arcade'));
    expect(verdict.pass).toBe(false);
    expect(verdict.fatalErrors).toHaveLength(1);
    expect(verdict.noEvidence).toBe(false);
  });

  it('is inert (passes, noEvidence) when there is no trace and no predicates', () => {
    const obs: AttemptObservation = { trace: null, fatalErrors: [] };
    const verdict = buildRepairVerdict(obs, []);
    expect(verdict.pass).toBe(true);
    expect(verdict.noEvidence).toBe(true);
    expect(verdict.score).toBeNull();
  });

  it('a fatal error with no trace/predicates still fails (a crash is always a failure)', () => {
    const obs: AttemptObservation = { trace: null, fatalErrors: ['boot crashed'] };
    const verdict = buildRepairVerdict(obs, []);
    expect(verdict.pass).toBe(false);
    expect(verdict.noEvidence).toBe(false);
  });
});

describe('buildRepairInstruction', () => {
  it('names the failing predicate + field, never a generic "try again"', () => {
    const verdict = buildRepairVerdict(
      { trace: INVERTED_TOPDOWN_TRACE, fatalErrors: [] },
      predicatesFor('topdown_arcade'),
    );
    const instruction = buildRepairInstruction(verdict);
    expect(instruction).not.toBeNull();
    expect(instruction!).toContain('playerPos.x');
    expect(instruction!).toMatch(/did NOT (increase|change|decrease)/);
    expect(instruction!.toLowerCase()).not.toContain('try again');
  });

  it('lists runtimeVerify fatal boot errors', () => {
    const verdict: RepairVerdict = {
      pass: false,
      score: null,
      fatalErrors: ['Uncaught Error: boot blew up'],
      noEvidence: false,
    };
    const instruction = buildRepairInstruction(verdict);
    expect(instruction).not.toBeNull();
    expect(instruction!).toContain('runtimeVerify');
    expect(instruction!).toContain('boot blew up');
  });

  it('returns null when the verdict carries no concrete failure', () => {
    const verdict: RepairVerdict = { pass: true, score: null, fatalErrors: [], noEvidence: true };
    expect(buildRepairInstruction(verdict)).toBeNull();
  });
});

describe('decideRepairAction', () => {
  it('ships with reason=passed on a clean verdict (0 rounds)', () => {
    const verdict = buildRepairVerdict(
      { trace: PASSING_TOPDOWN_TRACE, fatalErrors: [] },
      predicatesFor('topdown_arcade'),
    );
    const action = decideRepairAction(verdict, completableSpec('topdown_arcade'), loopState());
    expect(action).toEqual({ kind: 'ship', reason: 'passed' });
  });

  it('triggers exactly ONE repair round on a failing predicate, with a specific instruction', () => {
    const verdict = buildRepairVerdict(
      { trace: INVERTED_TOPDOWN_TRACE, fatalErrors: [] },
      predicatesFor('topdown_arcade'),
    );
    const action = decideRepairAction(verdict, completableSpec('topdown_arcade'), loopState());
    expect(action.kind).toBe('repair');
    if (action.kind === 'repair') {
      expect(action.instruction).toContain('playerPos.x');
    }
  });

  it('ships with reason=repair_exhausted once the ceiling is reached and it still fails', () => {
    const verdict = buildRepairVerdict(
      { trace: INVERTED_TOPDOWN_TRACE, fatalErrors: [] },
      predicatesFor('topdown_arcade'),
    );
    // roundsRun === maxRounds → no rounds remaining.
    const action = decideRepairAction(
      verdict,
      completableSpec('topdown_arcade'),
      loopState({ roundsRun: 2, maxRounds: 2 }),
    );
    expect(action).toEqual({ kind: 'ship', reason: 'repair_exhausted' });
  });

  it('ships with reason=skipped_non_completable for a non-completable spec (escape hatch)', () => {
    // A puzzle with no fail state (loseCondition '—') is non-completable even
    // though its genre ships a playbook with predicates — the failing trace
    // must NOT trigger a repair.
    const verdict = buildRepairVerdict(
      { trace: INVERTED_TOPDOWN_TRACE, fatalErrors: [] },
      predicatesFor('topdown_arcade'),
    );
    const nonCompletable: CompletabilitySpec = {
      genre: 'topdown_arcade',
      winCondition: '—',
      loseCondition: '—',
    };
    const action = decideRepairAction(verdict, nonCompletable, loopState());
    expect(action).toEqual({ kind: 'ship', reason: 'skipped_non_completable' });
  });

  it('ships with reason=budget_exhausted when the validation-tail budget is gone', () => {
    const verdict = buildRepairVerdict(
      { trace: INVERTED_TOPDOWN_TRACE, fatalErrors: [] },
      predicatesFor('topdown_arcade'),
    );
    const action = decideRepairAction(
      verdict,
      completableSpec('topdown_arcade'),
      loopState({ budgetExhausted: true }),
    );
    expect(action).toEqual({ kind: 'ship', reason: 'budget_exhausted' });
  });

  it('ships with reason=no_verdict when there is no deterministic evidence', () => {
    const verdict = buildRepairVerdict({ trace: null, fatalErrors: [] }, []);
    const action = decideRepairAction(verdict, completableSpec('topdown_arcade'), loopState());
    expect(action).toEqual({ kind: 'ship', reason: 'no_verdict' });
  });

  it('simulated full loop: fail → repair → pass terminates with 1 round', () => {
    const spec = completableSpec('topdown_arcade');
    const predicates = predicatesFor('topdown_arcade');
    let roundsRun = 0;
    // Round 0: inverted (fails) → repair.
    const v0 = buildRepairVerdict({ trace: INVERTED_TOPDOWN_TRACE, fatalErrors: [] }, predicates);
    const a0 = decideRepairAction(v0, spec, loopState({ roundsRun }));
    expect(a0.kind).toBe('repair');
    roundsRun += 1;
    // Round 1: agent fixed the sign error → passing trace → ship.
    const v1 = buildRepairVerdict({ trace: PASSING_TOPDOWN_TRACE, fatalErrors: [] }, predicates);
    const a1 = decideRepairAction(v1, spec, loopState({ roundsRun }));
    expect(a1).toEqual({ kind: 'ship', reason: 'passed' });
    expect(roundsRun).toBe(1);
  });

  it('simulated full loop: never repairs past the ceiling (terminates)', () => {
    const spec = completableSpec('topdown_arcade');
    const predicates = predicatesFor('topdown_arcade');
    const maxRounds = resolveMaxRepairRounds(undefined); // 2
    let roundsRun = 0;
    let lastReason = '';
    // The agent never fixes it — the trace stays inverted every round.
    for (let i = 0; i < 10; i++) {
      const verdict = buildRepairVerdict(
        { trace: INVERTED_TOPDOWN_TRACE, fatalErrors: [] },
        predicates,
      );
      const action = decideRepairAction(verdict, spec, loopState({ roundsRun, maxRounds }));
      if (action.kind === 'ship') {
        lastReason = action.reason;
        break;
      }
      roundsRun += 1;
    }
    expect(roundsRun).toBe(maxRounds);
    expect(lastReason).toBe('repair_exhausted');
  });
});

describe('selectGamePlaytestPlan (planner glue)', () => {
  it('projects a genre playbook onto synthetic-input steps + flattened predicates', () => {
    const plan = selectGamePlaytestPlan('topdown_arcade');
    expect(plan).not.toBeNull();
    expect(plan!.steps.length).toBeGreaterThan(0);
    expect(plan!.predicates.length).toBeGreaterThan(0);
    // The topdown playbook is all key steps (WASD).
    expect(plan!.steps.every((s) => s.kind === 'key')).toBe(true);
  });

  it('returns null for a genre with no bundled playbook', () => {
    expect(selectGamePlaytestPlan('idle')).toBeNull();
    expect(selectGamePlaytestPlan('sandbox')).toBeNull();
  });

  it('the fps playbook projects mouse + key steps (look + move)', () => {
    const plan = selectGamePlaytestPlan('fps');
    expect(plan).not.toBeNull();
    expect(plan!.steps.some((s) => s.kind === 'mouseDown' || s.kind === 'mouseMove')).toBe(true);
    expect(plan!.steps.some((s) => s.kind === 'key')).toBe(true);
  });
});
