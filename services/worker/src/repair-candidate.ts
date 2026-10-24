import type { RepairVerdict } from '@playforge/agent-core';

/** Positive means candidate is better. Compare only runs of the SAME locked
 * verification plan. Unknown evidence must never outrank observed behavior. */
export function compareRepairVerdicts(
  candidate: RepairVerdict | null,
  previous: RepairVerdict | null,
): number {
  const rank = (v: RepairVerdict | null): number => {
    if (v === null || v.noEvidence) return 0;
    if (v.fatalErrors.length > 0) return 1;
    if (!v.pass) return 2;
    return v.score !== null ? 4 : v.floorVerified ? 3 : 0;
  };
  const difference = rank(candidate) - rank(previous);
  if (difference !== 0) return difference;
  if (candidate === null || previous === null) return 0;
  const fatalDifference = previous.fatalErrors.length - candidate.fatalErrors.length;
  if (fatalDifference !== 0) return fatalDifference;
  if (candidate.score && previous.score) {
    // Refuse comparisons across a changed test suite rather than reward deleting checks.
    const signature = (v: RepairVerdict) =>
      JSON.stringify(v.score?.results.map((r) => r.predicate));
    if (signature(candidate) !== signature(previous)) return 0;
    return previous.score.failures - candidate.score.failures;
  }
  return 0;
}
