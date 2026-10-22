/**
 * The static whole-project checks, in one place so `done`, `verify_artifact` and the end-of-run
 * repair all agree on what "broken" means.
 */
import { describeMissingDomId, findMissingDomIds } from './dom-ids.js';
import { describeUnknownControlsCall, findUnknownControlsCalls } from './runtime-api.js';
import {
  type ProjectFile,
  describeUnresolvedImport,
  findUnresolvedImports,
} from './unresolved-imports.js';

export interface ProjectProblem {
  source: 'imports' | 'dom-ids' | 'runtime-api';
  message: string;
}

/** Every statically detectable boot-time problem. */
export function projectProblems(files: ProjectFile[]): ProjectProblem[] {
  return [
    ...findUnresolvedImports(files).map((p) => ({
      source: 'imports' as const,
      message: describeUnresolvedImport(p),
    })),
    ...findMissingDomIds(files).map((m) => ({
      source: 'dom-ids' as const,
      message: describeMissingDomId(m, files),
    })),
    ...findUnknownControlsCalls(files).map((c) => ({
      source: 'runtime-api' as const,
      message: describeUnknownControlsCall(c),
    })),
  ];
}

/** The subset a rewrite of `src/**.js` alone can fix (a missing page id needs index.html). */
export function sourceFixableProblems(files: ProjectFile[]): ProjectProblem[] {
  return projectProblems(files).filter((p) => p.source !== 'dom-ids');
}
