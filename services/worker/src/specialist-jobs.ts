/**
 * S7 — parallel specialist jobs for a parent generation run.
 *
 * Pure orchestration helpers used by run-generation. Specialists may write
 * only under their path sandbox; only the parent run may call `done`.
 */

import {
  type SpecialistBrief,
  type SpecialistKind,
  isPathAllowedForSpecialist,
  mergeSpecialistWrites,
  planSpecialists,
} from '@playforge/agent-core';

export interface SpecialistJobPlan {
  enabled: boolean;
  briefs: SpecialistBrief[];
  /** Parent-only: specialists must not invoke done. */
  parentOwnsDone: true;
}

export interface SpecialistWriteBatch {
  kind: SpecialistKind;
  files: Map<string, string>;
}

/** Feature flag: set PLAYFORGE_SPECIALISTS=1 to fan out after choose_engine. */
export function specialistsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['PLAYFORGE_SPECIALISTS'] === '1' || env['PLAYFORGE_SPECIALISTS'] === 'true';
}

/** Build the specialist job plan for a parent run (after choose_engine). */
export function buildSpecialistJobPlan(input: {
  gameSpecJson: string;
  engine: 'phaser' | 'three' | 'canvas2d';
  enabled?: boolean;
}): SpecialistJobPlan {
  const enabled = input.enabled ?? specialistsEnabled();
  if (!enabled) {
    return { enabled: false, briefs: [], parentOwnsDone: true };
  }
  return {
    enabled: true,
    briefs: planSpecialists({
      gameSpecJson: input.gameSpecJson,
      engine: input.engine,
    }),
    parentOwnsDone: true,
  };
}

/** Reject writes that escape a specialist's sandbox. */
export function filterSpecialistWrites(
  kind: SpecialistKind,
  files: ReadonlyMap<string, string>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const [path, content] of files) {
    if (isPathAllowedForSpecialist(kind, path)) out.set(path, content);
  }
  return out;
}

/** Merge specialist results into the parent working-tree file map. */
export function applySpecialistResults(
  base: ReadonlyMap<string, string>,
  batches: readonly SpecialistWriteBatch[],
): Map<string, string> {
  return mergeSpecialistWrites(
    base,
    batches.map((b) => ({
      kind: b.kind,
      files: filterSpecialistWrites(b.kind, b.files),
    })),
  );
}

/** Assert a specialist job must not call done (parent-only). */
export function assertSpecialistMayNotDone(kind: SpecialistKind, toolName: string): void {
  if (toolName === 'done') {
    throw new Error(
      `Specialist "${kind}" cannot call done — only the parent run may accept the artifact (S7).`,
    );
  }
}
