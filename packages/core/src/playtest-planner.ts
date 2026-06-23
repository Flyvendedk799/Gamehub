/**
 * Phase 6 — interaction playtest planner (game-mode `playtest_game` backport).
 *
 * Game-mode catches rotation/aim sign errors via synthetic input → state
 * playtest. Design-mode has the same blind spot: a form's `onsubmit` may
 * silently fail, an `onclick` handler may noop, an aria-target may
 * mismatch the live DOM. The planner inspects an HTML artifact and
 * returns a small set of high-leverage playtest steps (≤ 5) the runtime
 * can execute via Playwright at verify time.
 *
 * Pure parser — no IO, no Playwright dependency. Returns a plan; the
 * caller decides whether to actually execute it (lazy-loaded per the
 * §5 hard constraint).
 */

import type { GameGenre } from '@playforge/shared';
import type { FrameRef, PlaytestPredicate } from './eval/playtest-score.js';
import {
  type PlaybookStep,
  type PlaytestPlaybook,
  getPlaytestPlaybook,
} from './playtest-playbooks.js';

export interface PlaytestStep {
  /** What the runtime should do. */
  action: 'click' | 'fill' | 'submit' | 'hover';
  /** CSS selector or text-target. Caller resolves. */
  target: string;
  /** Optional input value for `fill`. */
  value?: string;
  /** Why this step is in the plan — telemetry / debug. */
  reason: string;
}

export interface PlaytestPlan {
  /** Whether the artifact carries enough interactivity to warrant a
   *  playtest. When false the runtime should skip Playwright entirely
   *  and only run the static lint + console capture. */
  shouldPlaytest: boolean;
  steps: ReadonlyArray<PlaytestStep>;
}

const MAX_STEPS = 5;

/** Plan a playtest from an HTML artifact. Picks the smallest set of
 *  actions that covers the artifact's documented interactivity surface
 *  area: forms (submit), top-N CTAs (click), hover-bearing nav. */
export function planPlaytest(html: string): PlaytestPlan {
  const steps: PlaytestStep[] = [];
  const lower = html.toLowerCase();
  // Heuristic: any of these signals interactivity worth probing.
  const hasForm = lower.includes('<form');
  const hasOnclick = lower.includes('onclick=') || lower.includes("addEventListener('click");
  const hasNav = lower.includes('<nav') || lower.includes('role="nav');
  if (!hasForm && !hasOnclick && !hasNav) {
    return { shouldPlaytest: false, steps: [] };
  }

  // 1. Forms — fill required fields with stub values, then submit.
  const formMatches = html.match(/<form[^>]*>[\s\S]*?<\/form>/gi) ?? [];
  for (const form of formMatches) {
    const inputs = (form.match(/<input[^>]+name="([^"]+)"[^>]*>/gi) ?? []).slice(0, 3);
    for (const input of inputs) {
      const name = (input.match(/name="([^"]+)"/i) ?? [])[1];
      if (!name) continue;
      const inputType = (input.match(/type="([^"]+)"/i) ?? [])[1] ?? 'text';
      const value = inputType === 'email' ? 'test@example.com' : 'playtest';
      steps.push({
        action: 'fill',
        target: `input[name="${name}"]`,
        value,
        reason: `form input "${name}" must accept value`,
      });
      if (steps.length >= MAX_STEPS) break;
    }
    if (steps.length >= MAX_STEPS) break;
    // Submit — first form only, then move on to other interactivity.
    steps.push({
      action: 'submit',
      target: 'form',
      reason: 'form submission should not throw',
    });
    break;
  }

  // 2. Click an aria-button or onclick element if room remains.
  if (steps.length < MAX_STEPS && hasOnclick) {
    steps.push({
      action: 'click',
      target: '[onclick], button, [role="button"]',
      reason: 'top onclick handler should not error',
    });
  }

  // 3. Hover the first nav element if room remains.
  if (steps.length < MAX_STEPS && hasNav) {
    steps.push({
      action: 'hover',
      target: 'nav a:first-of-type, [role="nav"] a:first-of-type',
      reason: 'nav hover should not throw',
    });
  }

  return {
    shouldPlaytest: steps.length > 0,
    steps: steps.slice(0, MAX_STEPS),
  };
}

// ---------------------------------------------------------------------------
// #1.6 — game-mode playbook → synthetic-input plan selection.
//
// The design-mode `planPlaytest` above parses an HTML artifact. The
// boot-and-repair loop (#1.6) needs the GAME-mode counterpart: given the
// declared GameSpec genre, pick the canonical playbook (Phase 9) and project
// it onto (a) the synthetic-input step list the browser-worker dispatches and
// (b) the flattened machine-checkable predicate set (Phase 5.4) the pure
// `scorePlaytest` evaluates the resulting trace against. Both pieces come from
// the SAME playbook so the predicates' `{ step: n }` frame refs line up 1:1
// with the steps we send (the trace's frame at index n is the snapshot after
// the n-th step). No IO, no LLM — pure selection + projection.
// ---------------------------------------------------------------------------

/** Synthetic-input step shape the browser-worker dispatches. Structurally
 *  identical to the agent `playtest_game` tool's union and the worker's
 *  `BrowserJobsPort.playtest` steps; re-declared here so the planner has no
 *  dependency on the tools layer or the worker. */
export type GamePlaytestStep =
  | { kind: 'key'; code: string; frames?: number }
  | { kind: 'mouseMove'; x: number; y: number }
  | { kind: 'mouseDown'; button?: number }
  | { kind: 'mouseUp'; button?: number }
  | { kind: 'wait'; frames: number };

/** The genre-selected game playtest plan: the playbook it came from, the
 *  ordered synthetic-input steps to dispatch, and the flattened predicate
 *  set to score the trace against. `predicates` is empty when the playbook
 *  carries only free-form English asserts (no machine-checkable rows) — the
 *  repair loop treats an empty predicate set as "nothing to gate on". */
export interface GamePlaytestPlan {
  playbook: PlaytestPlaybook;
  steps: GamePlaytestStep[];
  predicates: PlaytestPredicate[];
}

/** Project one playbook step onto the browser-worker's synthetic-input
 *  union. A `mouse` step with movement deltas becomes a `mouseMove` (the
 *  worker's relative-pointer dispatch); a bare `mouse` (click) becomes a
 *  `mouseDown`; `wait` maps its `durationFrames` onto `frames`. Returns
 *  null for a step we can't faithfully dispatch so the caller drops it
 *  rather than sending a malformed event. */
function projectPlaybookStep(step: PlaybookStep): GamePlaytestStep | null {
  if (step.kind === 'key') {
    if (step.code === undefined) return null;
    return step.frames !== undefined
      ? { kind: 'key', code: step.code, frames: step.frames }
      : { kind: 'key', code: step.code };
  }
  if (step.kind === 'wait') {
    // Playbook waits carry `durationFrames`; the worker step uses `frames`.
    const frames = step.durationFrames ?? step.frames ?? 1;
    return { kind: 'wait', frames };
  }
  // kind === 'mouse' — a movement delta is a look/aim move; otherwise a click.
  if (step.movementX !== undefined || step.movementY !== undefined) {
    // The browser-worker's mouseMove takes a normalised viewport coordinate
    // (0..1). The playbook authors relative pointer-lock deltas; we can't
    // faithfully convert those to absolute coords, so we anchor the move to
    // screen-centre — enough to drive a look handler that reads movementX via
    // a pointer-lock listener. The predicate set is what actually gates, and
    // the look-delta playbooks (fps) ship English asserts, not predicates.
    return { kind: 'mouseMove', x: 0.5, y: 0.5 };
  }
  return step.button !== undefined
    ? { kind: 'mouseDown', button: step.button }
    : { kind: 'mouseDown' };
}

/**
 * Select the canonical game playtest plan for a declared genre. Returns null
 * when no playbook is bundled for the genre (the repair loop then has no
 * deterministic verdict to gate on and ships as-is). Pure.
 */
export function selectGamePlaytestPlan(genre: GameGenre): GamePlaytestPlan | null {
  const playbook = getPlaytestPlaybook(genre);
  if (playbook === null) return null;
  const steps: GamePlaytestStep[] = [];
  for (const step of playbook.steps) {
    const projected = projectPlaybookStep(step);
    if (projected !== null) steps.push(projected);
  }
  const predicates = playbook.steps.flatMap((s) => s.predicates ?? []);
  return { playbook, steps, predicates: [...predicates] };
}

// Plan step 5c — the universal interactivity FLOOR. For a genre with no built-in
// predicates AND no agent contract, this is the fallback verdict source instead of
// shipping `no_verdict` (unjudged): drive a generic input burst and require SOME
// tracked snapshot field to change between the idle baseline and the post-input
// final frame. A game that wires its debug snapshot + responds to input PASSES; one
// that ignores input FAILS (→ repair); one with no snapshot at all can't be read —
// the caller treats that as honest no_verdict (no worse than before).
const FLOOR_PLAYBOOK: PlaytestPlaybook = {
  schemaVersion: 1,
  genre: 'other',
  intent: 'Universal interactivity floor — verify the game responds to input at all.',
  steps: [
    { kind: 'wait', durationFrames: 20, assert: 'Idle baseline before any input.' },
    { kind: 'key', code: 'ArrowRight', frames: 15, assert: 'Common movement input.' },
    { kind: 'key', code: 'ArrowLeft', frames: 15, assert: 'Common movement input.' },
    { kind: 'key', code: 'Space', frames: 8, assert: 'Common action input.' },
    { kind: 'mouse', button: 0, assert: 'Pointer interaction.' },
    { kind: 'wait', durationFrames: 20, assert: 'Settle, then read the snapshot.' },
  ],
  watchFor: ['The game ignores all input — tracked state never changes.'],
};

export function buildInteractivityFloorPlan(): GamePlaytestPlan {
  const steps: GamePlaytestStep[] = [];
  for (const step of FLOOR_PLAYBOOK.steps) {
    const projected = projectPlaybookStep(step);
    if (projected !== null) steps.push(projected);
  }
  const floorPredicate: PlaytestPredicate = {
    field: '*',
    op: 'any-changed',
    frame: 'final',
    against: 'baseline',
    label: 'interactivity floor — tracked state changes in response to input',
  };
  return { playbook: FLOOR_PLAYBOOK, steps, predicates: [floorPredicate] };
}

// ---------------------------------------------------------------------------
// Agent-authored playtest contracts — the path for genre-LESS / novel games.
//
// The genre playbooks above cover known shapes. A game that doesn't fit a genre
// (`genre: 'other'`, or any genre with no bundled playbook) would otherwise ship
// `no_verdict` — verified for BOOT but never for PLAY — so a beautiful-but-broken
// novel mechanic is indistinguishable from a working one. The fix: the agent
// declares its OWN input→state contract for the game it is about to build, and
// we project it onto the SAME { steps, predicates } the genre playbooks produce,
// scored by the SAME pure `scorePlaytest`. The integrity guard lives in the
// authoring flow (the contract is committed BEFORE the build, in declare order),
// not here — this is a pure, total projection.
// ---------------------------------------------------------------------------

/** One input→state check in an agent-authored contract. `action` drives a
 *  synthetic input; the optional `assert*` fields turn the snapshot AFTER that
 *  input into a machine-checkable predicate. A check with no `assertField` is a
 *  pure setup/settle step (e.g. a `wait` to let physics resolve). */
export interface AuthoredContractCheck {
  action: 'key' | 'pointerMove' | 'pointerDown' | 'pointerUp' | 'wait';
  /** KeyboardEvent.code for `action: 'key'`. */
  key?: string;
  /** Frames to hold a key / advance a wait. */
  holdFrames?: number;
  /** Normalised viewport target (0..1) for `action: 'pointerMove'`. */
  x?: number;
  y?: number;
  /** Dotted snapshot path to assert on, e.g. `progress` or `playerPos.x`. */
  assertField?: string;
  assertOp?:
    | 'increases'
    | 'decreases'
    | 'changes'
    | 'unchanged'
    | 'greaterThan'
    | 'lessThan'
    | 'equals';
  /** Comparison value for greaterThan / lessThan / equals. */
  assertValue?: number;
  /** Compare against the PREVIOUS asserting check instead of the pre-input
   *  baseline (for round-trips like move-left-then-right). Default false. */
  assertVsPrevious?: boolean;
}

export interface AuthoredContract {
  intent: string;
  checks: AuthoredContractCheck[];
}

const CONTRACT_OP_MAP: Record<
  NonNullable<AuthoredContractCheck['assertOp']>,
  PlaytestPredicate['op']
> = {
  increases: 'increased',
  decreases: 'decreased',
  changes: 'changed',
  unchanged: 'unchanged',
  greaterThan: 'gt',
  lessThan: 'lt',
  equals: 'eq',
};

const LITERAL_OPS = new Set<PlaytestPredicate['op']>(['eq', 'gt', 'lt']);

/** Project one contract check onto the browser-worker's synthetic-input union.
 *  Returns null only for a `key` check missing its `code` (the tool validates
 *  this up front, so in practice never). */
function projectContractAction(check: AuthoredContractCheck): GamePlaytestStep | null {
  switch (check.action) {
    case 'key':
      if (check.key === undefined || check.key.length === 0) return null;
      return check.holdFrames !== undefined
        ? { kind: 'key', code: check.key, frames: check.holdFrames }
        : { kind: 'key', code: check.key };
    case 'pointerMove':
      return { kind: 'mouseMove', x: clamp01(check.x ?? 0.5), y: clamp01(check.y ?? 0.5) };
    case 'pointerDown':
      return { kind: 'mouseDown' };
    case 'pointerUp':
      return { kind: 'mouseUp' };
    case 'wait':
      return { kind: 'wait', frames: check.holdFrames ?? 30 };
  }
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Build a deterministic playtest plan from an agent-authored contract. Each
 * check becomes one synthetic-input step; checks carrying an `assertField`
 * additionally become a machine-checkable predicate whose subject frame is that
 * step and whose comparison frame is the prior asserting step (or the pre-input
 * baseline). Pure + total: malformed checks are dropped, never thrown. The
 * synthetic playbook keeps the GamePlaytestPlan shape uniform with the genre
 * path (the boot-and-repair loop reads only `steps` + `predicates`).
 */
export function planFromContract(contract: AuthoredContract): GamePlaytestPlan {
  const steps: GamePlaytestStep[] = [];
  const predicates: PlaytestPredicate[] = [];
  let prevAssertStepIdx: number | null = null;

  for (const check of contract.checks) {
    const projected = projectContractAction(check);
    if (projected === null) continue;
    const stepIdx = steps.length;
    steps.push(projected);

    if (check.assertField !== undefined && check.assertField.length > 0 && check.assertOp) {
      const op = CONTRACT_OP_MAP[check.assertOp];
      const needsValue = LITERAL_OPS.has(op);
      if (needsValue && check.assertValue === undefined) continue; // tool validates; skip if absent
      const against: FrameRef =
        check.assertVsPrevious === true && prevAssertStepIdx !== null
          ? { step: prevAssertStepIdx }
          : 'baseline';
      predicates.push({
        field: check.assertField,
        op,
        frame: { step: stepIdx },
        ...(needsValue ? {} : { against }),
        ...(needsValue && check.assertValue !== undefined ? { value: check.assertValue } : {}),
      });
      prevAssertStepIdx = stepIdx;
    }
  }

  const playbook: PlaytestPlaybook = {
    schemaVersion: 1,
    genre: 'other',
    intent: contract.intent,
    steps: [],
    watchFor: [],
  };
  return { playbook, steps, predicates };
}
