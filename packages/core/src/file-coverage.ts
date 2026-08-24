/**
 * Coverage-based retention for view results.
 *
 * `buildActiveFileResultIds` keeps the last N tool results for the file the
 * agent is editing. That counts *results*, and it is the wrong unit — which
 * cost run 5f7e6510 twenty-six minutes.
 *
 * The model reads a file it cannot hold in one block by paging:
 *
 *     view[1,50] → view[50,135] → view[135,220] → view[220,320] → view[320,430] → view[430,540]
 *
 * One logical "read the file" is six results. With `ACTIVE_FILE_WINDOW = 6`
 * the window holds exactly one read and nothing else, so the very next `patch`
 * evicts the oldest chunk. The model's picture of the file now has a hole in
 * it, so it pages the whole thing again — six more round trips, roughly a
 * minute of wall clock, producing bytes identical to the ones just discarded.
 * That run did it fourteen times: 86 of its 120 edit-tool calls were views,
 * and 92% of its runtime was spent waiting on the model rather than on tools.
 *
 * The fix is to bound retention by **what the kept results actually show**
 * rather than by how many there are. Walking newest→oldest, a view is kept
 * only if it reveals lines no newer kept view already covers. So:
 *
 *   - six non-overlapping chunks that together form the current file are all
 *     kept, however many other tool calls happened in between;
 *   - a re-read of lines already covered by a newer result is dropped as
 *     redundant, because the newer one is what the file says now.
 *
 * This is *smaller* than the old scheme on the exact history that broke it —
 * fourteen redundant re-reads collapse to one coverage set — while removing
 * the reason the model re-read at all.
 */

import type { AgentMessage } from '@mariozechner/pi-agent-core';

/** Inclusive line span a view revealed. `end: null` means "to end of file". */
export interface LineSpan {
  readonly start: number;
  readonly end: number | null;
}

export interface CoverageOptions {
  /**
   * Hard ceiling on results kept per file, so a pathological history cannot
   * pin unbounded context. A file needing more than this many *non-overlapping*
   * reads is big enough that the agent should be splitting it anyway.
   */
  readonly maxResultsPerFile?: number | undefined;
  /**
   * Mutations kept per file regardless of coverage. A `str_replace` result is
   * not re-derivable by reading — it is the record of what the agent just did —
   * so a few of the most recent are always pinned.
   */
  readonly maxMutationsPerFile?: number | undefined;
}

const DEFAULT_MAX_RESULTS_PER_FILE = 12;
const DEFAULT_MAX_MUTATIONS_PER_FILE = 3;

/** Commands that read rather than write. */
const READ_COMMANDS = new Set(['view']);

/** Parse `view_range` into a span. Absent range means the whole file. */
export function spanOf(args: Record<string, unknown>): LineSpan {
  const range = args['view_range'];
  if (!Array.isArray(range) || range.length === 0) return { start: 1, end: null };
  const start = Number(range[0]);
  const rawEnd = range.length > 1 ? Number(range[1]) : Number.NaN;
  return {
    start: Number.isFinite(start) && start > 0 ? start : 1,
    // A negative or non-finite end is the tool's "to EOF" spelling.
    end: Number.isFinite(rawEnd) && rawEnd > 0 ? rawEnd : null,
  };
}

/**
 * Is `span` entirely revealed by spans already kept?
 *
 * Deliberately strict: a partially-covered span is kept, because the lines it
 * adds are exactly the ones the model would otherwise have to go back for. The
 * whole point is that the retained set is complete.
 */
export function isCovered(span: LineSpan, covered: readonly LineSpan[]): boolean {
  let cursor = span.start;
  const end = span.end;

  // Walk left to right, extending past every covered span that touches the
  // cursor. Sorting makes one pass enough.
  const sorted = [...covered].sort((a, b) => a.start - b.start);
  for (const other of sorted) {
    if (other.start > cursor) break;
    const otherEnd = other.end ?? Number.POSITIVE_INFINITY;
    if (otherEnd >= cursor) cursor = Math.max(cursor, otherEnd + 1);
    if (end !== null && cursor > end) return true;
    if (end === null && cursor === Number.POSITIVE_INFINITY) return true;
  }

  if (end === null) return cursor === Number.POSITIVE_INFINITY;
  return cursor > end;
}

interface EditCall {
  readonly id: string;
  readonly path: string;
  readonly command: string;
  readonly args: Record<string, unknown>;
}

/** Every edit-tool call in the history, newest first. */
function editCallsNewestFirst(messages: AgentMessage[], toolName: string): EditCall[] {
  const out: EditCall[] = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== 'assistant') continue;
    const original = message as unknown as { content?: Array<Record<string, unknown>> };
    if (!Array.isArray(original.content)) continue;

    // Blocks within one message are also newest-last, so walk them backwards
    // to keep the global ordering strictly newest-first.
    for (let b = original.content.length - 1; b >= 0; b -= 1) {
      const block = original.content[b];
      if (block?.['type'] !== 'toolCall' || block['name'] !== toolName) continue;
      const args =
        (block['arguments'] as Record<string, unknown> | undefined) ??
        (block['input'] as Record<string, unknown> | undefined);
      if (typeof args !== 'object' || args === null) continue;
      const path = args['path'];
      const id = block['id'];
      if (typeof path !== 'string' || path.length === 0) continue;
      if (typeof id !== 'string' || id.length === 0) continue;
      out.push({ id, path, command: String(args['command'] ?? ''), args });
    }
  }
  return out;
}

export interface CoverageReport {
  /** Result ids to exempt from pruning. */
  readonly keep: Set<string>;
  /** Results dropped because a newer read already showed those lines. */
  readonly redundantReads: number;
  /** Per-file spans retained, for logging. */
  readonly coverage: ReadonlyMap<string, readonly LineSpan[]>;
}

/**
 * Choose which edit-tool results to keep so each active file stays whole.
 *
 * Newest wins: when two reads overlap, the newer one is what the file says
 * now, and the older is dropped. That is what makes this shrink context on
 * the histories that used to blow it up.
 */
export function buildFileCoverageResultIds(
  messages: AgentMessage[],
  activeFiles: readonly string[],
  toolName: string,
  options: CoverageOptions = {},
): CoverageReport {
  const maxResults = Math.max(1, options.maxResultsPerFile ?? DEFAULT_MAX_RESULTS_PER_FILE);
  const maxMutations = Math.max(0, options.maxMutationsPerFile ?? DEFAULT_MAX_MUTATIONS_PER_FILE);

  const keep = new Set<string>();
  const coverage = new Map<string, LineSpan[]>();
  const kept = new Map<string, number>();
  const mutations = new Map<string, number>();
  let redundantReads = 0;

  if (activeFiles.length === 0) return { keep, redundantReads, coverage };
  const wanted = new Set(activeFiles);

  for (const call of editCallsNewestFirst(messages, toolName)) {
    if (!wanted.has(call.path)) continue;
    if ((kept.get(call.path) ?? 0) >= maxResults) continue;

    if (READ_COMMANDS.has(call.command)) {
      const span = spanOf(call.args);
      const already = coverage.get(call.path) ?? [];
      if (isCovered(span, already)) {
        // A newer read already shows these lines. Keeping this one would pin
        // a second copy of the same content — the waste that made the old
        // window overflow in the first place.
        redundantReads += 1;
        continue;
      }
      coverage.set(call.path, [...already, span]);
    } else {
      const used = mutations.get(call.path) ?? 0;
      if (used >= maxMutations) continue;
      mutations.set(call.path, used + 1);
    }

    keep.add(call.id);
    kept.set(call.path, (kept.get(call.path) ?? 0) + 1);
  }

  return { keep, redundantReads, coverage };
}
