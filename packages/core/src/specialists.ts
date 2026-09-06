/**
 * S7 — parallel specialist agents (systems / art / audio).
 *
 * After declare_game_spec + choose_engine, the parent run can fan out three
 * child jobs that share the GameSpec + scene document. Only the parent may
 * call `done`; specialists write files / assets and exit. This cuts the
 * serial token tax Summer's domain experts already avoid.
 *
 * This module is the pure planning/merge contract used by the worker queue.
 * The actual BullMQ wiring lives in services/worker (specialist-jobs.ts).
 */

export type SpecialistKind = 'systems' | 'art' | 'audio';

export interface SpecialistBrief {
  kind: SpecialistKind;
  /** Spec JSON the parent already declared — specialists must not re-declare. */
  gameSpecJson: string;
  /** Engine the parent already chose. */
  engine: 'phaser' | 'three' | 'canvas2d';
  /** Paths the specialist may write under (everything else is rejected). */
  allowedPathPrefixes: readonly string[];
  /** Soft token budget for this specialist. */
  maxTokens: number;
}

export interface SpecialistResult {
  kind: SpecialistKind;
  /** Relative paths written. */
  writtenPaths: string[];
  /** Token usage for cost accounting. */
  inputTokens: number;
  outputTokens: number;
  /** Non-fatal notes the parent should see. */
  notes: string[];
}

const ALLOWED: Record<SpecialistKind, readonly string[]> = {
  systems: ['src/', 'index.html'],
  art: ['assets/', 'src/art/', 'src/sprites/', 'src/materials/'],
  audio: ['assets/audio/', 'src/audio/', 'src/sfx/'],
};

const TOKEN_BUDGET: Record<SpecialistKind, number> = {
  systems: 120_000,
  art: 60_000,
  audio: 40_000,
};

/** Build the three specialist briefs for a parent run. Pure. */
export function planSpecialists(input: {
  gameSpecJson: string;
  engine: 'phaser' | 'three' | 'canvas2d';
}): SpecialistBrief[] {
  return (['systems', 'art', 'audio'] as const).map((kind) => ({
    kind,
    gameSpecJson: input.gameSpecJson,
    engine: input.engine,
    allowedPathPrefixes: ALLOWED[kind],
    maxTokens: TOKEN_BUDGET[kind],
  }));
}

/** Reject a specialist write that escapes its sandbox. */
export function isPathAllowedForSpecialist(
  kind: SpecialistKind,
  path: string,
): boolean {
  const normalized = path.replace(/^\.?\//, '');
  return ALLOWED[kind].some(
    (prefix) => normalized === prefix.replace(/\/$/, '') || normalized.startsWith(prefix),
  );
}

/** Merge specialist file maps; later kinds do not overwrite systems entry points. */
export function mergeSpecialistWrites(
  base: ReadonlyMap<string, string>,
  results: ReadonlyArray<{ kind: SpecialistKind; files: ReadonlyMap<string, string> }>,
): Map<string, string> {
  const out = new Map(base);
  const protectedPaths = new Set(['index.html', 'src/main.js', 'src/main.ts']);
  for (const result of results) {
    for (const [path, content] of result.files) {
      if (!isPathAllowedForSpecialist(result.kind, path)) continue;
      if (result.kind !== 'systems' && protectedPaths.has(path.replace(/^\.?\//, ''))) continue;
      out.set(path, content);
    }
  }
  return out;
}
