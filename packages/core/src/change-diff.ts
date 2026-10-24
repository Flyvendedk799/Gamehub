/**
 * A compact line diff of an edit, for anything that has to read what changed: the repair agent
 * told which lines the host just rewrote, and the second-chance summary written from the diff
 * when the model did not summarise its own edit.
 */

/** Line diff of two texts as unified-diff hunks with `context` lines around each change. */
export function unifiedDiff(before: string, after: string, context = 2): string[] {
  const a = before.split('\n');
  const b = after.split('\n');
  // Longest common subsequence over lines. Edited files are a few hundred lines, so O(n*m) is fine.
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) return [`@@ file too large to diff (${n} -> ${m} lines) @@`];
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j]
          ? (lcs[i + 1]![j + 1] ?? 0) + 1
          : Math.max(lcs[i + 1]![j] ?? 0, lcs[i]![j + 1] ?? 0);
    }
  }
  type Op = { kind: ' ' | '-' | '+'; text: string; ai: number; bj: number };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ kind: ' ', text: a[i] as string, ai: i, bj: j });
      i++;
      j++;
    } else if (j < m && (i === n || (lcs[i]![j + 1] ?? 0) >= (lcs[i + 1]![j] ?? 0))) {
      ops.push({ kind: '+', text: b[j] as string, ai: i, bj: j });
      j++;
    } else {
      ops.push({ kind: '-', text: a[i] as string, ai: i, bj: j });
      i++;
    }
  }
  const changed = ops.map((op) => op.kind !== ' ');
  const keep = new Array<boolean>(ops.length).fill(false);
  for (let k = 0; k < ops.length; k++) {
    if (!changed[k]) continue;
    for (let c = Math.max(0, k - context); c <= Math.min(ops.length - 1, k + context); c++) {
      keep[c] = true;
    }
  }
  const out: string[] = [];
  for (let k = 0; k < ops.length; k++) {
    if (!keep[k]) continue;
    if (k === 0 || !keep[k - 1]) out.push(`@@ around line ${(ops[k] as Op).ai + 1} @@`);
    const op = ops[k] as Op;
    out.push(`${op.kind}${op.text}`);
  }
  return out;
}

/**
 * What an edit changed, for the repair agent that has to find out why a check that passed before
 * now fails. Per file: how much changed, then the changed lines with a little context, capped so
 * the prompt stays small.
 */
export function describeChange(
  before: ReadonlyMap<string, string>,
  after: ReadonlyArray<{ path: string; content: string }>,
  maxChars = 6000,
): string {
  const parts: string[] = [];
  let used = 0;
  for (const file of after) {
    const prior = before.get(file.path);
    if (prior === file.content) continue;
    const hunks = unifiedDiff(prior ?? '', file.content);
    const added = hunks.filter((l) => l.startsWith('+')).length;
    const removed = hunks.filter((l) => l.startsWith('-')).length;
    const header = `--- ${file.path} (+${added} -${removed})`;
    const room = Math.max(0, maxChars - used - header.length - 40);
    let body = hunks.join('\n');
    if (body.length > room) body = `${body.slice(0, room)}\n… (more changes in this file; view it)`;
    const block = `${header}\n${body}`;
    parts.push(block);
    used += block.length;
    if (used >= maxChars) break;
  }
  return parts.join('\n\n');
}
