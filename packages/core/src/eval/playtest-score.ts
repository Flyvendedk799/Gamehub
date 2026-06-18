/**
 * Phase 5.4 — machine-checkable playtest predicates.
 *
 * The free-form `assert` strings on `PlaytestPlaybook` steps (see
 * `playtest-playbooks.ts`) read like English ("Player x is INCREASING")
 * and can only be checked by a human or an LLM judge. That is exactly the
 * gap the brawler `c44763af…` sign error slipped through: nobody could
 * DETERMINISTICALLY assert that pressing D moved the player toward +x.
 *
 * This module turns those English asserts into a small predicate schema
 * + a PURE evaluator over a playtest snapshot trace. A predicate names a
 * dotted field path into the snapshot object (e.g. `playerPos.x`), an
 * operator (`increased` / `decreased` / `changed` / `unchanged` / `eq` /
 * `gt` / `lt`), and — for comparison ops — a baseline frame and/or a
 * literal value to compare against. The evaluator reads the trace and
 * returns pass/fail with a human-readable reason; NO LLM, NO IO.
 *
 * Design intent (#1.6 boot-and-repair loop consumes this):
 *   - The trace shape matches what `playtest_game`/the browser-worker
 *     already produces: a baseline snapshot + an ordered list of
 *     per-step snapshots. We accept `unknown` snapshots (the debug
 *     getter is engine-defined) and resolve dotted paths defensively.
 *   - Predicates are data (JSON-serialisable), so a fixture, a playbook,
 *     or the repair loop can all author them and feed them to the SAME
 *     pure `scorePlaytest()`.
 *   - The evaluator is total: a missing field, a non-numeric value, or
 *     an out-of-range frame index is a deterministic FAIL with a reason,
 *     never a throw. The repair loop needs a verdict, not an exception.
 */

export const PLAYTEST_PREDICATE_OPS = [
  'increased',
  'decreased',
  'changed',
  'unchanged',
  'eq',
  'gt',
  'lt',
] as const;
export type PlaytestPredicateOp = (typeof PLAYTEST_PREDICATE_OPS)[number];

/**
 * Where in the trace a predicate reads its "current" value from.
 *   - `final`       — the snapshot after the LAST step (default).
 *   - `{ step: n }` — the snapshot after step index `n` (0-based).
 *   - `baseline`    — the pre-input baseline snapshot.
 */
export type FrameRef = 'final' | 'baseline' | { step: number };

export interface PlaytestPredicate {
  /** Dotted path into the snapshot, e.g. `playerPos.x` or `score`.
   *  Array indices are supported: `enemies.0.hp`. */
  field: string;
  op: PlaytestPredicateOp;
  /** Frame whose value is the predicate's subject. Defaults to `final`. */
  frame?: FrameRef;
  /** For relative ops (`increased`/`decreased`/`changed`/`unchanged`),
   *  the frame to compare AGAINST. Defaults to `baseline`. */
  against?: FrameRef;
  /** For literal ops (`eq`/`gt`/`lt`), the value to compare to. */
  value?: number;
  /** Minimum absolute delta for `increased`/`decreased`/`changed` to
   *  count (filters out float jitter). Defaults to 0 (any non-zero
   *  delta). For `unchanged`, the max tolerated drift. Defaults to 0. */
  epsilon?: number;
  /** Optional human label surfaced in the result; falls back to a
   *  generated description. */
  label?: string;
}

/** One snapshot frame in a playtest trace. `snapshot` is the serialised
 *  return of the engine's `window.__game.debug.snapshot()` — engine
 *  defined, so typed `unknown` and resolved defensively. */
export interface PlaytestFrame {
  /** Index of the step this snapshot was captured after. Informational. */
  stepIndex: number;
  snapshot: unknown;
}

/** The trace a playtest produces: a baseline (pre-input) snapshot plus an
 *  ordered list of post-step snapshots. Maps 1:1 onto the worker's
 *  `PlaytesterOutput` (`baselineSnapshot` + `steps[*].snapshotAfter`). */
export interface PlaytestTrace {
  baseline: unknown;
  frames: ReadonlyArray<PlaytestFrame>;
}

export interface PredicateResult {
  predicate: PlaytestPredicate;
  pass: boolean;
  /** Human-readable explanation — always set, pass or fail. */
  reason: string;
  /** Resolved subject value, when numeric. */
  observed?: number;
  /** Resolved comparison value (baseline frame value or literal), when
   *  numeric and applicable. */
  baseline?: number;
}

export interface PlaytestScore {
  pass: boolean;
  results: ReadonlyArray<PredicateResult>;
  /** Count of failing predicates. */
  failures: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Resolve a dotted path against a snapshot. Returns `undefined` for any
 * missing segment (defensive — a missing field is a FAIL, not a throw).
 * Supports object keys and numeric array indices.
 */
export function resolvePath(snapshot: unknown, path: string): unknown {
  const segments = path.split('.');
  let cursor: unknown = snapshot;
  for (const seg of segments) {
    if (cursor === undefined || cursor === null) return undefined;
    if (Array.isArray(cursor)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cursor.length) return undefined;
      cursor = cursor[idx];
      continue;
    }
    if (isRecord(cursor)) {
      cursor = cursor[seg];
      continue;
    }
    return undefined;
  }
  return cursor;
}

const OUT_OF_RANGE = Symbol('frame-out-of-range');

function frameSnapshot(trace: PlaytestTrace, ref: FrameRef): unknown | typeof OUT_OF_RANGE {
  if (ref === 'baseline') return trace.baseline;
  if (ref === 'final') {
    const last = trace.frames[trace.frames.length - 1];
    return last === undefined ? trace.baseline : last.snapshot;
  }
  const idx = ref.step;
  const frame = trace.frames[idx];
  if (frame === undefined) return OUT_OF_RANGE;
  return frame.snapshot;
}

function describeFrame(ref: FrameRef): string {
  if (ref === 'baseline') return 'baseline';
  if (ref === 'final') return 'final';
  return `step ${ref.step}`;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

const RELATIVE_OPS = new Set<PlaytestPredicateOp>([
  'increased',
  'decreased',
  'changed',
  'unchanged',
]);

/**
 * Evaluate a single predicate against a trace. Total: never throws.
 */
export function evaluatePredicate(
  trace: PlaytestTrace,
  predicate: PlaytestPredicate,
): PredicateResult {
  const subjectRef: FrameRef = predicate.frame ?? 'final';
  const subjectSnap = frameSnapshot(trace, subjectRef);
  const label =
    predicate.label ??
    `${predicate.field} ${predicate.op}${
      predicate.value !== undefined ? ` ${predicate.value}` : ''
    } @ ${describeFrame(subjectRef)}`;

  const fail = (reason: string, observed?: number, baseline?: number): PredicateResult => ({
    predicate,
    pass: false,
    reason,
    ...(observed !== undefined ? { observed } : {}),
    ...(baseline !== undefined ? { baseline } : {}),
  });
  const pass = (reason: string, observed?: number, baseline?: number): PredicateResult => ({
    predicate,
    pass: true,
    reason,
    ...(observed !== undefined ? { observed } : {}),
    ...(baseline !== undefined ? { baseline } : {}),
  });

  if (subjectSnap === OUT_OF_RANGE) {
    return fail(`${label}: subject frame ${describeFrame(subjectRef)} is out of range`);
  }

  const subjectRaw = resolvePath(subjectSnap, predicate.field);
  if (subjectRaw === undefined) {
    return fail(`${label}: field '${predicate.field}' is missing at ${describeFrame(subjectRef)}`);
  }

  // Literal-comparison ops.
  if (predicate.op === 'eq' || predicate.op === 'gt' || predicate.op === 'lt') {
    if (predicate.value === undefined) {
      return fail(`${label}: op '${predicate.op}' requires a 'value'`);
    }
    const subjectNum = asNumber(subjectRaw);
    if (subjectNum === undefined) {
      // eq supports non-numeric equality; gt/lt require numbers.
      if (predicate.op === 'eq') {
        const ok = subjectRaw === predicate.value;
        return ok
          ? pass(`${label}: ${String(subjectRaw)} === ${predicate.value}`)
          : fail(`${label}: ${String(subjectRaw)} !== ${predicate.value}`);
      }
      return fail(`${label}: field '${predicate.field}' is non-numeric (${String(subjectRaw)})`);
    }
    const v = predicate.value;
    const ok =
      predicate.op === 'eq'
        ? subjectNum === v
        : predicate.op === 'gt'
          ? subjectNum > v
          : subjectNum < v;
    const sym = predicate.op === 'eq' ? '===' : predicate.op === 'gt' ? '>' : '<';
    return ok
      ? pass(`${label}: ${subjectNum} ${sym} ${v}`, subjectNum, v)
      : fail(`${label}: ${subjectNum} ${sym} ${v} is false`, subjectNum, v);
  }

  // Relative ops compare the subject frame against another frame.
  if (RELATIVE_OPS.has(predicate.op)) {
    const againstRef: FrameRef = predicate.against ?? 'baseline';
    const againstSnap = frameSnapshot(trace, againstRef);
    if (againstSnap === OUT_OF_RANGE) {
      return fail(`${label}: against frame ${describeFrame(againstRef)} is out of range`);
    }
    const againstRaw = resolvePath(againstSnap, predicate.field);
    if (againstRaw === undefined) {
      return fail(
        `${label}: field '${predicate.field}' is missing at ${describeFrame(againstRef)}`,
      );
    }
    const subjectNum = asNumber(subjectRaw);
    const againstNum = asNumber(againstRaw);
    if (subjectNum === undefined || againstNum === undefined) {
      return fail(`${label}: relative op '${predicate.op}' requires numeric values`);
    }
    const delta = subjectNum - againstNum;
    const eps = predicate.epsilon ?? 0;
    const against = describeFrame(againstRef);
    switch (predicate.op) {
      case 'increased':
        return delta > eps
          ? pass(`${label}: rose by ${delta} (vs ${against})`, subjectNum, againstNum)
          : fail(
              `${label}: did NOT increase — delta ${delta} (subject ${subjectNum} vs ${against} ${againstNum})`,
              subjectNum,
              againstNum,
            );
      case 'decreased':
        return delta < -eps
          ? pass(`${label}: fell by ${-delta} (vs ${against})`, subjectNum, againstNum)
          : fail(
              `${label}: did NOT decrease — delta ${delta} (subject ${subjectNum} vs ${against} ${againstNum})`,
              subjectNum,
              againstNum,
            );
      case 'changed':
        return Math.abs(delta) > eps
          ? pass(`${label}: changed by ${delta} (vs ${against})`, subjectNum, againstNum)
          : fail(`${label}: unchanged — delta ${delta} ≤ epsilon ${eps}`, subjectNum, againstNum);
      case 'unchanged':
        return Math.abs(delta) <= eps
          ? pass(`${label}: stable — delta ${delta} ≤ epsilon ${eps}`, subjectNum, againstNum)
          : fail(
              `${label}: drifted by ${delta} (> epsilon ${eps}, vs ${against})`,
              subjectNum,
              againstNum,
            );
    }
  }

  // Unreachable given the op union, but total by construction.
  return fail(`${label}: unsupported op '${String(predicate.op)}'`);
}

/**
 * Score a whole predicate set against a trace. Pure; deterministic.
 * `pass` is true only when EVERY predicate passes.
 */
export function scorePlaytest(
  trace: PlaytestTrace,
  predicates: ReadonlyArray<PlaytestPredicate>,
): PlaytestScore {
  const results = predicates.map((p) => evaluatePredicate(trace, p));
  const failures = results.filter((r) => !r.pass).length;
  return { pass: failures === 0, results, failures };
}

const VALID_OPS = new Set<string>(PLAYTEST_PREDICATE_OPS);

function parseFrameRef(raw: unknown, key: string): FrameRef {
  if (raw === 'final' || raw === 'baseline') return raw;
  if (isRecord(raw) && typeof raw['step'] === 'number') {
    const step = raw['step'];
    if (!Number.isInteger(step) || step < 0) {
      throw new Error(`predicate.${key}.step must be a non-negative integer`);
    }
    return { step };
  }
  throw new Error(`predicate.${key} must be 'final', 'baseline', or { step: n }`);
}

/**
 * Parse-validate a predicate authored in JSON (a fixture, a playbook, or
 * the repair loop's proposal). Throws on a malformed schema so bad
 * predicates fail loudly at load time, not silently at eval time.
 */
export function parsePlaytestPredicate(raw: unknown): PlaytestPredicate {
  if (!isRecord(raw)) throw new Error('predicate must be an object');
  const field = raw['field'];
  if (typeof field !== 'string' || field.length === 0) {
    throw new Error('predicate.field must be a non-empty string');
  }
  const op = raw['op'];
  if (typeof op !== 'string' || !VALID_OPS.has(op)) {
    throw new Error(`predicate.op must be one of ${PLAYTEST_PREDICATE_OPS.join(', ')}`);
  }
  const out: PlaytestPredicate = { field, op: op as PlaytestPredicateOp };
  if (raw['frame'] !== undefined) out.frame = parseFrameRef(raw['frame'], 'frame');
  if (raw['against'] !== undefined) out.against = parseFrameRef(raw['against'], 'against');
  if (raw['value'] !== undefined) {
    if (typeof raw['value'] !== 'number' || !Number.isFinite(raw['value'])) {
      throw new Error('predicate.value must be a finite number');
    }
    out.value = raw['value'];
  }
  if (raw['epsilon'] !== undefined) {
    if (
      typeof raw['epsilon'] !== 'number' ||
      !Number.isFinite(raw['epsilon']) ||
      raw['epsilon'] < 0
    ) {
      throw new Error('predicate.epsilon must be a non-negative number');
    }
    out.epsilon = raw['epsilon'];
  }
  if (raw['label'] !== undefined) {
    if (typeof raw['label'] !== 'string') throw new Error('predicate.label must be a string');
    out.label = raw['label'];
  }
  if ((out.op === 'eq' || out.op === 'gt' || out.op === 'lt') && out.value === undefined) {
    throw new Error(`predicate.op '${out.op}' requires a 'value'`);
  }
  return out;
}
