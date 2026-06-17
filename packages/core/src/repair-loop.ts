/**
 * Phase 1.6 — bounded boot-and-repair loop (pure orchestration core).
 *
 * Phases 1.1–1.5 + 5.3/5.4 made the generation guardrails REAL: a real
 * out-of-process playtester + runtimeVerify (1.4), a blocking design-
 * completability floor in `done` (1.5), and a pure deterministic predicate
 * scorer (`scorePlaytest`, 5.4). What was still missing: when the REAL
 * playtest verdict says the game is broken (pressing D moved the player the
 * wrong way), the run shipped it anyway. There was no mechanism to feed the
 * concrete failure back into the agent and let it fix the game before the
 * snapshot is finalised.
 *
 * This module is that mechanism's BRAIN — pure, no IO, no LLM, no browser.
 * The worker (`run-generation.ts`) owns the side-effecting shell: it runs the
 * agent, round-trips the real playtest through the browser-jobs queue, and
 * RE-INVOKES the agent with the repair instruction this module authors. The
 * decision of whether to ship, repair, or stop is made HERE, deterministically:
 *
 *   - Verdict: `scorePlaytest(trace, predicates)` (5.4) + `runtimeVerify`
 *     fatalErrors. The LLM is NEVER consulted for pass/fail — it only ACTS on
 *     the repair instruction text we hand it.
 *   - Bounded: a default round budget (2) under a hard ceiling (3). Each round
 *     also respects the worker's validation-tail token/tool budget (1.2); when
 *     that's exhausted we stop and ship the best attempt reached.
 *   - Specific: the repair instruction names the exact failing predicate, the
 *     field, the observed-vs-expected values, plus any runtimeVerify fatal
 *     error. Generic "try again" is never emitted.
 *   - Escape hatch: non-completable specs (sandbox / idle / winCondition '—')
 *     skip predicate-gated repair entirely — mirrors the completable-spec gate
 *     Phase 1.5 added in assert-game-invariants.ts / done.ts.
 *
 * Isolation: this file never boots game code. The worker passes us already-
 * computed verdicts (a trace + fatalErrors) gathered out-of-process; we reason
 * over data only.
 */

import { isCompletableSpec, type CompletabilitySpec } from './tools/assert-game-invariants.js';
import {
  type PlaytestPredicate,
  type PlaytestScore,
  type PlaytestTrace,
  type PredicateResult,
  scorePlaytest,
} from './eval/playtest-score.js';

/** Default number of repair rounds attempted before shipping the best
 *  attempt. A single repair round already recovers the common sign-error /
 *  unwired-input class; two gives the agent a second pass for a partial fix.
 *  Stays well under the hard ceiling so the validation tail (1.2) is the
 *  binding constraint on a busy run, not this. */
export const DEFAULT_MAX_REPAIR_ROUNDS = 2;

/** Absolute hard ceiling on repair rounds, regardless of the configured
 *  default. A misconfigured caller can never drive the loop past this — the
 *  loop is bounded and terminating by construction. */
export const MAX_REPAIR_ROUNDS_CEILING = 3;

/** Clamp a requested round budget into `[0, MAX_REPAIR_ROUNDS_CEILING]`. A
 *  caller may opt OUT of repair entirely with 0; anything above the ceiling is
 *  capped. Non-finite / negative inputs fall back to the default. */
export function resolveMaxRepairRounds(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested) || requested < 0) {
    return DEFAULT_MAX_REPAIR_ROUNDS;
  }
  return Math.min(Math.floor(requested), MAX_REPAIR_ROUNDS_CEILING);
}

/**
 * Why the run shipped the artifact it shipped. Surfaced on
 * `GenerationResult.shipReason` so Phase 5.6 telemetry + the dashboard can
 * distinguish a clean pass from an exhausted-repair ship.
 *   - `passed`                   — the deterministic verdict passed (0 or N
 *                                  rounds), nothing left to fix.
 *   - `repair_exhausted`         — the round ceiling was reached and the
 *                                  verdict still failed; we shipped the best
 *                                  attempt.
 *   - `budget_exhausted`         — the worker's validation-tail token/tool
 *                                  budget ran out mid-loop; we stopped early
 *                                  and shipped the current best.
 *   - `skipped_non_completable`  — the spec is a non-completable / creative
 *                                  toy (sandbox / idle / no fail state); the
 *                                  predicate gate is inert by design.
 *   - `no_verdict`               — no deterministic verdict was obtainable
 *                                  (no genre playbook with predicates, or the
 *                                  browser-worker returned nothing); we have no
 *                                  evidence to repair on, so we ship as-is.
 */
export type ShipReason =
  | 'passed'
  | 'repair_exhausted'
  | 'budget_exhausted'
  | 'skipped_non_completable'
  | 'no_verdict';

/** The deterministic verdict for a single attempt. Combines the predicate
 *  score (5.4) with any runtimeVerify fatal boot errors (1.4). `pass` is true
 *  only when the predicate set passed AND no fatal boot errors were observed. */
export interface RepairVerdict {
  /** True when nothing is broken: predicates passed and no fatal boot error. */
  pass: boolean;
  /** The predicate score, or null when no trace / no predicates were available
   *  (an evidence-free attempt — never a failure, just nothing to gate on). */
  score: PlaytestScore | null;
  /** runtimeVerify fatal boot errors observed for this attempt (1.4). */
  fatalErrors: ReadonlyArray<string>;
  /** True when there was simply no deterministic evidence to judge: no trace,
   *  no predicates, and no fatal errors. The loop ships an evidence-free
   *  attempt rather than repairing blind. */
  noEvidence: boolean;
}

/** The verdict input the worker hands us per attempt: the out-of-process
 *  playtest trace (or null when the browser-worker gave no verdict) plus the
 *  runtimeVerify fatal errors. Both are gathered out-of-process; this module
 *  only reasons over them. */
export interface AttemptObservation {
  /** Playtest trace mapped from the browser-worker `PlaytesterOutput`, or
   *  null when no playtest verdict was obtained. */
  trace: PlaytestTrace | null;
  /** runtimeVerify fatal boot errors (window.__game never appeared / console
   *  errors). Empty when the boot was clean or no verdict was obtained. */
  fatalErrors: ReadonlyArray<string>;
}

/**
 * Build the deterministic verdict for one attempt. Pure: scores the trace
 * against the predicate set and folds in the fatal boot errors. When there is
 * no trace OR no predicates, the predicate gate is inert (score null) — the
 * verdict then passes UNLESS a fatal boot error is present (a crash is always a
 * failure even with no predicates to check).
 */
export function buildRepairVerdict(
  observation: AttemptObservation,
  predicates: ReadonlyArray<PlaytestPredicate>,
): RepairVerdict {
  const fatalErrors = [...observation.fatalErrors];
  const hasFatal = fatalErrors.length > 0;
  const canScore = observation.trace !== null && predicates.length > 0;
  const score = canScore ? scorePlaytest(observation.trace as PlaytestTrace, predicates) : null;
  const predicatesPass = score === null ? true : score.pass;
  const noEvidence = score === null && !hasFatal;
  return {
    pass: predicatesPass && !hasFatal,
    score,
    fatalErrors,
    noEvidence,
  };
}

/** Minimal shape of the playtest result the worker hands us — the same
 *  `baselineSnapshot` + per-step `snapshotAfter` the browser-worker's
 *  `PlaytesterOutput` carries. Re-declared structurally so this module has no
 *  dependency on the tools layer or the worker. */
export interface PlaytestResultLike {
  baselineSnapshot: unknown;
  steps: ReadonlyArray<{ snapshotAfter: unknown }>;
}

/**
 * Map a browser-worker playtest result onto the pure `PlaytestTrace` the
 * scorer consumes: the baseline becomes `trace.baseline`, and each step's
 * `snapshotAfter` becomes `frames[i]` with `stepIndex = i`. This is the 1:1
 * mapping the Phase 5.4 scorer was designed around — the playbook predicates'
 * `{ step: n }` refs then index the snapshot after the n-th dispatched step.
 * Pure.
 */
export function traceFromPlaytestResult(result: PlaytestResultLike): PlaytestTrace {
  return {
    baseline: result.baselineSnapshot,
    frames: result.steps.map((s, i) => ({ stepIndex: i, snapshot: s.snapshotAfter })),
  };
}

/** A failing predicate distilled to the bits a repair instruction needs: the
 *  human label, the field path, and the deterministic reason. */
export interface FailedPredicateSummary {
  field: string;
  label: string;
  reason: string;
}

function failedPredicates(score: PlaytestScore | null): FailedPredicateSummary[] {
  if (score === null) return [];
  return score.results
    .filter((r): r is PredicateResult => !r.pass)
    .map((r) => ({
      field: r.predicate.field,
      label: r.predicate.label ?? `${r.predicate.field} ${r.predicate.op}`,
      reason: r.reason,
    }));
}

/**
 * Author the structured, SPECIFIC repair instruction handed back to the agent
 * loop. Names each failing predicate (field + deterministic reason) and lists
 * any runtimeVerify fatal boot error. Never emits a generic "try again": when
 * called with a verdict that has no concrete failure it returns null (the
 * caller must not enter a repair round without something specific to fix).
 *
 * The text is intentionally imperative and concrete — it is the ONLY place the
 * LLM is involved in the loop (it ACTS on this text), so it must hand the agent
 * the exact field + observed/expected so it can locate the bug, not guess.
 */
export function buildRepairInstruction(verdict: RepairVerdict): string | null {
  const failures = failedPredicates(verdict.score);
  const fatal = verdict.fatalErrors;
  if (failures.length === 0 && fatal.length === 0) return null;

  const lines: string[] = [
    'PLAYTEST REPAIR — the automated playtest of your game FAILED a deterministic check. ' +
      'Fix the SPECIFIC issues below, then re-run validate_game_scene + playtest_game and call done again. ' +
      'Do not change anything unrelated.',
  ];

  if (fatal.length > 0) {
    lines.push('');
    lines.push('Runtime boot errors (the game crashed or never booted):');
    for (const err of fatal.slice(0, 6)) {
      lines.push(`  - runtimeVerify: ${err}`);
    }
  }

  if (failures.length > 0) {
    lines.push('');
    lines.push('Failed playtest assertions (field did not change as the genre playbook requires):');
    for (const f of failures.slice(0, 8)) {
      // The reason already carries observed-vs-expected from scorePlaytest;
      // surface it verbatim and lead with the field so the agent can grep its
      // own debug-snapshot shape for the wiring.
      lines.push(`  - playtest: ${f.reason} [field: ${f.field}]`);
    }
    lines.push('');
    lines.push(
      'These are MACHINE-CHECKED facts from the real running game, not opinions. ' +
        'A field that "did NOT increase/decrease/change" means the input is mis-wired or sign-flipped ' +
        '(the c44763af class). Trace the keydown/pointer handler for each named field and correct it.',
    );
  }

  return lines.join('\n');
}

/** The next thing the worker should do after scoring an attempt. */
export type RepairAction =
  | { kind: 'ship'; reason: ShipReason }
  | { kind: 'repair'; instruction: string };

/** The mutable loop state the worker tracks across rounds and hands to
 *  `decideRepairAction` each time. */
export interface RepairLoopState {
  /** Repair rounds already RUN (0 before the first repair). */
  roundsRun: number;
  /** The resolved max-rounds budget (already clamped to the ceiling). */
  maxRounds: number;
  /** Whether the worker's validation-tail token/tool budget is exhausted —
   *  when true the loop must stop and ship regardless of the verdict. The
   *  worker computes this from the agent's interrupted flag / token meter. */
  budgetExhausted: boolean;
}

/**
 * The bounded-loop decision function. Given the current attempt's verdict, the
 * declared spec, and the loop state, decide whether to ship (and why) or run
 * another repair round (with a specific instruction). Total + deterministic:
 *
 *   1. Non-completable spec → ship, `skipped_non_completable` (escape hatch).
 *   2. No deterministic evidence → ship, `no_verdict` (nothing to repair on).
 *   3. Verdict passes        → ship, `passed`.
 *   4. Budget exhausted      → ship, `budget_exhausted`.
 *   5. Rounds remaining      → repair with a specific instruction.
 *   6. Otherwise (ceiling reached, still failing) → ship, `repair_exhausted`.
 *
 * The instruction is built from the verdict; if — defensively — it comes back
 * null (no concrete failure despite a non-passing verdict, which the verdict
 * construction shouldn't produce) we ship as `repair_exhausted` rather than
 * enter a content-free round.
 */
export function decideRepairAction(
  verdict: RepairVerdict,
  spec: CompletabilitySpec | null | undefined,
  state: RepairLoopState,
): RepairAction {
  // (1) Escape hatch — non-completable / creative specs skip the predicate
  // gate entirely (mirror Phase 1.5's isCompletableSpec gate). A null/absent
  // spec is treated as completable: we have no declared escape, so honour the
  // verdict.
  if (spec !== null && spec !== undefined && !isCompletableSpec(spec)) {
    return { kind: 'ship', reason: 'skipped_non_completable' };
  }
  // (2) No deterministic evidence to judge — ship as-is rather than claim a
  // pass we can't substantiate or repair blind. Checked BEFORE the pass branch
  // because a no-evidence verdict is technically `pass: true` (nothing failed)
  // but we want it surfaced honestly as `no_verdict`, not `passed`.
  if (verdict.noEvidence) {
    return { kind: 'ship', reason: 'no_verdict' };
  }
  // (3) Clean pass.
  if (verdict.pass) {
    return { kind: 'ship', reason: 'passed' };
  }
  // (4) Validation-tail budget gone — stop and ship the best attempt.
  if (state.budgetExhausted) {
    return { kind: 'ship', reason: 'budget_exhausted' };
  }
  // (5) Rounds remaining — author a specific instruction and repair.
  if (state.roundsRun < state.maxRounds) {
    const instruction = buildRepairInstruction(verdict);
    if (instruction !== null) {
      return { kind: 'repair', instruction };
    }
  }
  // (6) Ceiling reached (or no concrete instruction) — ship the best attempt.
  return { kind: 'ship', reason: 'repair_exhausted' };
}
