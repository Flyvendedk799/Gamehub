/**
 * Per-run trace explainer — the four queries that explain almost any bad run.
 *
 * From docs/BUILD_SPEED_FROM_BOXER_RUNS.md ("Instrumentation to keep"). They were
 * written by hand, three times, against `runs` / `run_events` /
 * `run_quality_metrics` while comparing three identical builds. Keeping them as a
 * script means the next person reads a trace in a minute instead of rebuilding the
 * SQL from memory.
 *
 *   1. Wall clock vs AI runtime — is the time in the agent, or in the queue?
 *   2. Tool histogram           — what did it spend its calls on?
 *   3. Latency attribution      — is a TOOL slow, or is the MODEL thinking?
 *   4. View ranges              — a marching sequence of ranges is a linear scan.
 *
 * The compute lives in `@playforge/agent-core`'s `eval/trace-analysis` (pure and
 * unit-tested); this file is the SQL and the formatting.
 *
 * Usage (from repo root):
 *   npx tsx scripts/trace-run.ts <run-id>
 *   npx tsx scripts/trace-run.ts --latest
 *   DATABASE_URL=postgres://... npx tsx scripts/trace-run.ts --latest
 *
 * Defaults to postgres://localhost:5432/playforge when DATABASE_URL is unset.
 *
 * Postgres client: uses the same `postgres` (postgres-js) package that
 * @playforge/db depends on, imported via a relative path so pnpm's
 * package-scoped resolution finds it.
 *
 * Exit codes:
 *   0 — trace printed
 *   1 — fatal error (DB unreachable, unknown run id, …)
 */

import postgres from '../packages/db/node_modules/postgres/src/index.js';

import type { TraceAnalysis, TraceEvent } from '../packages/core/src/eval/trace-analysis.js';
import { analyzeRunTiming, analyzeTrace } from '../packages/core/src/eval/trace-analysis.js';

const DEFAULT_DATABASE_URL = 'postgres://localhost:5432/playforge';

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function section(title: string): void {
  console.log('');
  console.log(`── ${title} ${'─'.repeat(Math.max(0, 70 - title.length - 4))}`);
}

function kv(label: string, value: string): void {
  console.log(`  ${label.padEnd(28)} ${value}`);
}

function dur(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}min`;
}

function bar(value: number, max: number, width = 20): string {
  if (max <= 0 || value <= 0) return '';
  return '█'.repeat(Math.max(1, Math.round((value / max) * width)));
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

interface RunRow {
  id: string;
  status: string;
  created_at: Date;
  finished_at: Date | null;
  ai_runtime_ms: number;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  cache_creation_input_tokens: number;
  cost_usd: string;
}

interface EventRow {
  seq: number;
  created_at: Date;
  event: Record<string, unknown>;
}

const RUN_COLUMNS = `id, status, created_at, finished_at, ai_runtime_ms,
                     input_tokens, output_tokens, cached_input_tokens,
                     cache_creation_input_tokens, cost_usd`;

// ---------------------------------------------------------------------------
// Printers
// ---------------------------------------------------------------------------

function printTiming(run: RunRow): void {
  section('1. Wall clock vs AI runtime');
  const t = analyzeRunTiming({
    createdAtMs: run.created_at.getTime(),
    finishedAtMs: run.finished_at?.getTime() ?? null,
    aiRuntimeMs: run.ai_runtime_ms,
    nowMs: Date.now(),
  });
  kv('status', run.status);
  kv('wall clock', dur(t.wallClockMs));
  kv('AI runtime', t.aiRuntimeMs > 0 ? dur(t.aiRuntimeMs) : '—');
  // A large gap here is queue wait, not the agent — a different problem, and one
  // no amount of prompt work will fix.
  kv('queue / idle', dur(t.queueMs));
  if (t.aiShare !== null) kv('…AI share of wall', `${(t.aiShare * 100).toFixed(0)}%`);
  kv('output tokens', String(run.output_tokens));
  kv('input tokens (fresh)', String(run.input_tokens));
  kv('cache read / write', `${run.cached_input_tokens} / ${run.cache_creation_input_tokens}`);
  kv('cost', `$${Number(run.cost_usd).toFixed(4)}`);
}

function printHistogram(a: TraceAnalysis): void {
  section('2. Tool histogram');
  if (a.toolHistogram.length === 0) {
    console.log('  (no tool calls recorded)');
    return;
  }
  const max = a.toolHistogram[0]?.calls ?? 1;
  for (const t of a.toolHistogram) {
    console.log(`  ${t.name.padEnd(34)} ${String(t.calls).padStart(4)}  ${bar(t.calls, max)}`);
  }
  console.log(`  ${'TOTAL'.padEnd(34)} ${String(a.toolCallTotal).padStart(4)}`);
}

function printLatency(a: TraceAnalysis): void {
  section('3. Latency attribution (gap AFTER each tool = model thinking)');
  if (a.latency.length === 0) {
    console.log('  (no tool_execution_end events recorded)');
    return;
  }
  const max = a.latency[0]?.totalMs ?? 1;
  console.log(`  ${'tool'.padEnd(34)} ${'total'.padStart(8)} ${'per call'.padStart(9)}`);
  for (const l of a.latency) {
    console.log(
      `  ${l.name.padEnd(34)} ${dur(l.totalMs).padStart(8)} ${dur(l.perCallMs).padStart(9)}  ${bar(l.totalMs, max, 14)}`,
    );
  }
  console.log(`  ${'TOTAL'.padEnd(34)} ${dur(a.latencyTotalMs).padStart(8)}`);
}

function printViews(a: TraceAnalysis): void {
  section('4. View ranges (a marching sequence = a linear scan)');
  const v = a.views;
  if (v.total === 0) {
    console.log('  (no view calls recorded)');
    return;
  }
  kv('view calls', String(v.total));
  kv('…ranged', String(v.ranged));
  kv('…by symbol', String(v.bySymbol));
  kv('…whole file', String(v.wholeFile));
  if (a.viewsPerMutation !== null) {
    // §1's argument in one number: run 3 paid 37 views for 17 mutations of a
    // 1419-line file. Small modules should push this toward 1.
    kv('views per mutation', a.viewsPerMutation.toFixed(2));
  }
  for (const seq of v.sequences) {
    console.log('');
    console.log(`  ${seq.path}  (${seq.views} views)`);
    if (seq.ranges.length > 0) {
      console.log(`    ${seq.ranges.map(([s, e]) => `[${s},${e}]`).join(' ')}`);
    }
    if (seq.isLinearScan) {
      console.log(
        `    ⚠ linear scan: ${seq.longestForwardRun} consecutive forward ranges — the agent is walking this file to find something.`,
      );
    }
  }
}

function printBuildReport(report: Record<string, unknown> | null): void {
  if (report === null) return;
  section('Build report highlights');
  const show = (key: string): void => {
    const value = report[key];
    if (value === undefined || value === null) return;
    kv(key, Array.isArray(value) ? value.join(', ') || '—' : String(value));
  };
  for (const key of [
    'shipReason',
    'juiceScore',
    'repairRounds',
    // §1/§2 — did the modular scaffold survive, and how big did files get?
    'scaffoldSeeded',
    'scaffoldSurvived',
    'scaffoldDeleted',
    'entryFileLines',
    'maxFileLines',
    'maxFileLinesPath',
    'engineImports',
    'usesSkillFns',
    // §3 — did anything look at a frame, and did it help?
    'visionCalls',
    'visualFindingsBefore',
    'visualFindingsAfter',
    // §5/§6 — edit thrash, and what the restarts cost.
    'strReplaceFailures',
    'agentRestarts',
    'restartReestablishTokens',
  ]) {
    show(key);
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (arg === undefined || arg === '--help' || arg === '-h') {
    console.log('usage: npx tsx scripts/trace-run.ts <run-id> | --latest');
    process.exit(arg === undefined ? 1 : 0);
  }

  const sql = postgres(process.env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL, { max: 5 });
  try {
    const runs =
      arg === '--latest'
        ? await sql<RunRow[]>`SELECT ${sql.unsafe(RUN_COLUMNS)} FROM runs
                              ORDER BY created_at DESC LIMIT 1`
        : await sql<RunRow[]>`SELECT ${sql.unsafe(RUN_COLUMNS)} FROM runs WHERE id = ${arg}`;

    const run = runs[0];
    if (run === undefined) {
      console.error(arg === '--latest' ? 'No runs found.' : `No run with id ${arg}.`);
      process.exit(1);
    }

    const rows = await sql<EventRow[]>`
      SELECT seq, created_at, event
      FROM run_events
      WHERE run_id = ${run.id}
      ORDER BY seq ASC`;

    const quality = await sql<Array<{ report: Record<string, unknown> | null }>>`
      SELECT report FROM run_quality_metrics WHERE run_id = ${run.id}`;

    const events: TraceEvent[] = rows.map((r) => ({
      seq: r.seq,
      atMs: r.created_at.getTime(),
      event: r.event,
    }));
    const analysis = analyzeTrace(events);

    console.log('');
    console.log(`  Trace for run ${run.id}  (${events.length} events)`);
    printTiming(run);
    printHistogram(analysis);
    printLatency(analysis);
    printViews(analysis);
    printBuildReport(quality[0]?.report ?? null);
    console.log('');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err: unknown) => {
  console.error('trace-run: fatal error');
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
