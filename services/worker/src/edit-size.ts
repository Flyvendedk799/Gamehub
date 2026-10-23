/**
 * How much of the game an edit changed, in lines.
 *
 * A two-line bug fix ("movement is inverted") cannot regress how the game LOOKS, but the visual
 * critique still cost about 40 seconds and a vision call on it (run 63a9a036). The critique earns
 * its time on a large rewrite or a first build; this is how the run tells them apart.
 */

/** Lines the edit added or removed, summed across files (a changed line counts once, as removed
 *  plus added, so a one-line fix reads as 2). Multiset difference: moving a line costs nothing. */
export function countChangedLines(
  before: ReadonlyMap<string, string>,
  after: ReadonlyArray<{ path: string; content: string }>,
): number {
  let changed = 0;
  const seen = new Set<string>();
  for (const file of after) {
    seen.add(file.path);
    const prior = before.get(file.path);
    if (prior === undefined) {
      changed += file.content.split('\n').length;
      continue;
    }
    if (prior === file.content) continue;
    const pool = new Map<string, number>();
    for (const line of prior.split('\n')) pool.set(line, (pool.get(line) ?? 0) + 1);
    let added = 0;
    for (const line of file.content.split('\n')) {
      const left = pool.get(line) ?? 0;
      if (left > 0) pool.set(line, left - 1);
      else added += 1;
    }
    let removed = 0;
    for (const n of pool.values()) removed += n;
    changed += added + removed;
  }
  for (const [path, prior] of before) {
    if (!seen.has(path)) changed += prior.split('\n').length;
  }
  return changed;
}

/** At or below this many changed lines a specific edit is too small to need a visual look. */
export const SMALL_EDIT_LINES = 60;
