/**
 * Per-run trace analysis — the four queries that explain almost any bad run.
 *
 * From docs/BUILD_SPEED_FROM_BOXER_RUNS.md ("Instrumentation to keep"). They were
 * written by hand, three times, while comparing three identical builds. Keeping
 * them here means the next person reads a trace in a minute instead of rebuilding
 * the reasoning from memory.
 *
 *   1. Wall clock vs AI runtime — is the time in the agent, or in the queue?
 *   2. Tool histogram           — what did the run spend its calls on?
 *   3. Latency attribution      — is a TOOL slow, or is the MODEL thinking?
 *   4. View ranges              — a marching sequence of ranges is a linear scan.
 *
 * (3) is the one that matters. In every run measured so far the time has been
 * overwhelmingly the model, not the tools — which is why batching (§4) and
 * smaller files (§1) are the levers, rather than making tools faster.
 *
 * Pure, no I/O, no imports: callers hand in rows read from `runs` / `run_events`;
 * this module does the compute. `scripts/trace-run.ts` is the CLI over it.
 */

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** One `run_events` row: the raw AgentEvent jsonb plus its timestamp. */
export interface TraceEvent {
  seq: number;
  /** Epoch milliseconds. Callers convert their driver's Date for us. */
  atMs: number;
  event: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export interface ToolHistogramEntry {
  name: string;
  calls: number;
}

export interface LatencyEntry {
  name: string;
  /** Summed gap between this tool's `tool_execution_end` and the next event. */
  totalMs: number;
  calls: number;
  perCallMs: number;
}

export interface ViewSequence {
  path: string;
  views: number;
  ranges: Array<[number, number]>;
  /** Longest run of consecutive ranges that each start later than the last. */
  longestForwardRun: number;
  /** True when that run reaches `LINEAR_SCAN_THRESHOLD`. */
  isLinearScan: boolean;
}

export interface ViewAnalysis {
  total: number;
  ranged: number;
  bySymbol: number;
  wholeFile: number;
  sequences: ViewSequence[];
}

export interface TraceAnalysis {
  toolHistogram: ToolHistogramEntry[];
  toolCallTotal: number;
  latency: LatencyEntry[];
  /** Total time attributed to post-tool gaps — overwhelmingly model thinking. */
  latencyTotalMs: number;
  views: ViewAnalysis;
  /** Views per mutation. §1's whole argument: run 3 paid 37 views for 17 edits. */
  viewsPerMutation: number | null;
}

/**
 * Three consecutive forward ranges. Two can be an ordinary "read the top, then
 * read the function below it"; three is the shape the doc names —
 * `[160,240] [200,290] [240,320] [295,380]` — an agent walking a file because
 * it cannot find something.
 */
export const LINEAR_SCAN_THRESHOLD = 3;

const EDIT_TOOL = 'str_replace_based_edit_tool';
const MUTATING_COMMANDS = new Set(['create', 'str_replace', 'insert', 'patch']);

function toolNameOf(event: Record<string, unknown>): string {
  const tool = event['toolName'];
  if (typeof tool === 'string' && tool.length > 0) return tool;
  const type = event['type'];
  return typeof type === 'string' ? type : 'unknown';
}

function argsOf(event: Record<string, unknown>): Record<string, unknown> | null {
  const args = event['args'];
  return typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : null;
}

/** Wall clock vs AI runtime — a large gap is QUEUE time, a different problem
 *  entirely, and one no amount of prompt work will fix. */
export function analyzeRunTiming(input: {
  createdAtMs: number;
  finishedAtMs: number | null;
  aiRuntimeMs: number;
  nowMs: number;
}): { wallClockMs: number; aiRuntimeMs: number; queueMs: number; aiShare: number | null } {
  const end = input.finishedAtMs ?? input.nowMs;
  const wallClockMs = Math.max(0, end - input.createdAtMs);
  const aiRuntimeMs = Math.max(0, input.aiRuntimeMs);
  return {
    wallClockMs,
    aiRuntimeMs,
    queueMs: Math.max(0, wallClockMs - aiRuntimeMs),
    aiShare: wallClockMs > 0 ? Math.min(1, aiRuntimeMs / wallClockMs) : null,
  };
}

/** Every view call the run made, in order. */
export function analyzeViews(events: readonly TraceEvent[]): ViewAnalysis {
  interface ViewCall {
    path: string;
    range: [number, number] | null;
    symbol: string | null;
  }
  const calls: ViewCall[] = [];
  for (const row of events) {
    if (row.event['type'] !== 'tool_execution_start') continue;
    if (toolNameOf(row.event) !== EDIT_TOOL) continue;
    const args = argsOf(row.event);
    if (args === null || args['command'] !== 'view') continue;
    const raw = args['view_range'];
    const range =
      Array.isArray(raw) && typeof raw[0] === 'number' && typeof raw[1] === 'number'
        ? ([raw[0], raw[1]] as [number, number])
        : null;
    calls.push({
      path: typeof args['path'] === 'string' ? args['path'] : '?',
      range,
      symbol: typeof args['symbol'] === 'string' ? args['symbol'] : null,
    });
  }

  const byPath = new Map<string, ViewCall[]>();
  for (const call of calls) {
    const list = byPath.get(call.path) ?? [];
    list.push(call);
    byPath.set(call.path, list);
  }

  const sequences: ViewSequence[] = [];
  for (const [path, list] of byPath) {
    const ranges = list.map((v) => v.range).filter((r): r is [number, number] => r !== null);
    let current = ranges.length > 0 ? 1 : 0;
    let longest = current;
    for (let i = 1; i < ranges.length; i += 1) {
      const prev = ranges[i - 1];
      const cur = ranges[i];
      // Strictly forward: each window starts later than the one before it.
      if (prev !== undefined && cur !== undefined && cur[0] > prev[0]) {
        current += 1;
        longest = Math.max(longest, current);
      } else {
        current = 1;
      }
    }
    sequences.push({
      path,
      views: list.length,
      ranges,
      longestForwardRun: longest,
      isLinearScan: longest >= LINEAR_SCAN_THRESHOLD,
    });
  }
  sequences.sort((a, b) => b.views - a.views);

  const ranged = calls.filter((c) => c.range !== null).length;
  const bySymbol = calls.filter((c) => c.range === null && c.symbol !== null).length;
  return {
    total: calls.length,
    ranged,
    bySymbol,
    wholeFile: calls.length - ranged - bySymbol,
    sequences,
  };
}

/**
 * The whole trace.
 *
 * Latency attribution is the load-bearing part: the gap between a
 * `tool_execution_end` and the NEXT event is not the tool running — the tool has
 * already finished. It is the model deciding what to do next. Attributing that
 * gap to the tool that preceded it is what separates "this tool is slow" from
 * "the model spends ten seconds after every view", which are opposite problems
 * with opposite fixes.
 */
export function analyzeTrace(events: readonly TraceEvent[]): TraceAnalysis {
  const histogram = new Map<string, number>();
  const latency = new Map<string, { totalMs: number; calls: number }>();
  let mutations = 0;

  for (let i = 0; i < events.length; i += 1) {
    const row = events[i];
    if (row === undefined) continue;
    const type = row.event['type'];

    if (type === 'tool_execution_start') {
      const name = toolNameOf(row.event);
      histogram.set(name, (histogram.get(name) ?? 0) + 1);
      const args = argsOf(row.event);
      if (
        name === EDIT_TOOL &&
        args !== null &&
        typeof args['command'] === 'string' &&
        MUTATING_COMMANDS.has(args['command'])
      ) {
        mutations += 1;
      }
      continue;
    }

    if (type === 'tool_execution_end') {
      const next = events[i + 1];
      if (next === undefined) continue; // nothing follows — no gap to attribute
      const name = toolNameOf(row.event);
      const acc = latency.get(name) ?? { totalMs: 0, calls: 0 };
      acc.totalMs += Math.max(0, next.atMs - row.atMs);
      acc.calls += 1;
      latency.set(name, acc);
    }
  }

  const toolHistogram = [...histogram.entries()]
    .map(([name, calls]) => ({ name, calls }))
    .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));

  const latencyEntries = [...latency.entries()]
    .map(([name, acc]) => ({
      name,
      totalMs: acc.totalMs,
      calls: acc.calls,
      perCallMs: acc.calls > 0 ? acc.totalMs / acc.calls : 0,
    }))
    .sort((a, b) => b.totalMs - a.totalMs || a.name.localeCompare(b.name));

  const views = analyzeViews(events);
  return {
    toolHistogram,
    toolCallTotal: toolHistogram.reduce((sum, t) => sum + t.calls, 0),
    latency: latencyEntries,
    latencyTotalMs: latencyEntries.reduce((sum, l) => sum + l.totalMs, 0),
    views,
    viewsPerMutation: mutations > 0 ? views.total / mutations : null,
  };
}
