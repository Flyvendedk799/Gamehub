import type { GameProductionPlan, GameScenarioEvidence } from '@playforge/shared';
import { type PredicateResult, parsePlaytestPredicate, scorePlaytest } from './eval/playtest-score';
import { type RepairVerdict, traceFromPlaytestResult } from './repair-loop';
import type { PlaytestStep } from './tools/playtest-game';

export interface ScenarioTrace {
  hasGameContract: boolean;
  hasDebugContract: boolean;
  baselineSnapshot: unknown;
  bootErrors: readonly string[];
  steps: ReadonlyArray<{ snapshotAfter: unknown; errors: readonly string[] }>;
}

/** Each call must use a fresh isolated browser session. Never reuse state between scenarios. */
export async function runProductionSuite(
  plan: GameProductionPlan,
  play: (steps: PlaytestStep[]) => Promise<ScenarioTrace | null>,
  onScenario?: (title: string) => void,
): Promise<{ verdict: RepairVerdict; evidence: GameScenarioEvidence[] }> {
  const results: PredicateResult[] = [];
  const fatalErrors: string[] = [];
  const evidence: GameScenarioEvidence[] = [];
  for (const scenario of plan.scenarios) {
    onScenario?.(scenario.title);
    const steps: PlaytestStep[] = scenario.plan.steps.map((s) => {
      if (s.kind === 'key')
        return {
          kind: s.kind,
          code: s.code,
          ...(s.frames !== undefined ? { frames: s.frames } : {}),
        };
      if (s.kind === 'mouseDown' || s.kind === 'mouseUp')
        return { kind: s.kind, ...(s.button !== undefined ? { button: s.button } : {}) };
      if (s.kind === 'approach')
        return {
          kind: s.kind,
          watch: s.watch,
          ...(s.frames !== undefined ? { frames: s.frames } : {}),
        };
      return s;
    });
    // Queue failures are unavailable evidence, not a claim that game logic is broken.
    let trace: ScenarioTrace | null;
    try {
      trace = await play(steps);
    } catch {
      trace = null;
    }
    if (trace === null) {
      evidence.push({
        id: scenario.id,
        requirements: scenario.requirements,
        status: 'unavailable',
        assertions: scenario.plan.predicates.length,
        observed: 0,
        failures: [],
      });
      continue;
    }
    const errors = [...trace.bootErrors, ...trace.steps.flatMap((s) => s.errors)];
    if (!trace.hasGameContract) errors.push('Game runtime contract is missing.');
    if (!trace.hasDebugContract)
      errors.push(
        'Expose real game state with window.__game.debug.track so this scenario can observe the rules.',
      );
    if (trace.steps.length !== steps.length)
      errors.push(
        `Incomplete input trace: expected ${steps.length} steps, received ${trace.steps.length}.`,
      );
    const score = scorePlaytest(
      traceFromPlaytestResult(trace),
      scenario.plan.predicates.map(parsePlaytestPredicate),
    );
    const namedResults = score.results.map((result) => ({
      ...result,
      predicate: {
        ...result.predicate,
        label: `${scenario.id}: ${result.predicate.label ?? result.predicate.field}`,
      },
      reason: `[${scenario.title}] ${result.reason}`,
    }));
    results.push(...namedResults);
    fatalErrors.push(...errors.map((error) => `[${scenario.title}] ${error}`));
    evidence.push({
      id: scenario.id,
      requirements: scenario.requirements,
      status: score.pass && errors.length === 0 ? 'passed' : 'failed',
      assertions: scenario.plan.predicates.length,
      observed: score.observed,
      failures: [...errors, ...namedResults.filter((r) => !r.pass).map((r) => r.reason)],
    });
  }
  const failures = results.filter((r) => !r.pass).length;
  const unavailable = evidence.some((e) => e.status === 'unavailable');
  const pass = evidence.length > 0 && evidence.every((e) => e.status === 'passed');
  return {
    evidence,
    verdict: {
      pass,
      fatalErrors,
      noEvidence: unavailable && failures === 0 && fatalErrors.length === 0,
      score: results.length
        ? {
            pass: pass && failures === 0,
            results,
            failures,
            observed: results.filter((r) => r.fieldPresent).length,
          }
        : null,
    },
  };
}
