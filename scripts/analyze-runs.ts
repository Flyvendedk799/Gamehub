/**
 * Nightly run-report analyzer.
 *
 * Connects to the Playforge Postgres instance, fetches the 500 most-recent
 * run_quality_metrics rows that have a populated `report` JSONB column, parses
 * each report into a BuildReport, runs analyzeReports(), and pretty-prints the
 * resulting RunAnalysis to stdout.
 *
 * Usage (from repo root):
 *   npx tsx scripts/analyze-runs.ts
 *   DATABASE_URL=postgres://... npx tsx scripts/analyze-runs.ts
 *
 * Defaults to postgres://localhost:5432/playforge when DATABASE_URL is unset.
 *
 * Postgres client: uses the same `postgres` (postgres-js) package that
 * @playforge/db depends on. Imported via a relative path to packages/db so
 * pnpm's package-scoped node_modules resolution finds it.
 *
 * Exit codes:
 *   0 — analysis printed (or zero rows)
 *   1 — fatal error (DB unreachable, parse failure, etc.)
 */

// postgres-js is a direct dependency of packages/db; import it via that
// package's node_modules so pnpm's strict isolation is respected.
// tsx resolves the .ts extension on the source side automatically.
import postgres from '../packages/db/node_modules/postgres/src/index.js';

import type { BuildReport, RunAnalysis } from '../packages/core/src/eval/run-report-analysis.js';
import { analyzeReports } from '../packages/core/src/eval/run-report-analysis.js';

const DEFAULT_DATABASE_URL = 'postgres://localhost:5432/playforge';

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function num(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function printSection(title: string): void {
  const dashes = '─'.repeat(Math.max(0, 60 - title.length - 4));
  console.log('');
  console.log(`── ${title} ${dashes}`);
}

function printKv(label: string, value: string): void {
  console.log(`  ${label.padEnd(30)} ${value}`);
}

function printAnalysis(analysis: RunAnalysis, rowCount: number): void {
  const header = `  Playforge run-report analysis  (${rowCount} rows)`;
  const pad = ' '.repeat(Math.max(0, 63 - header.length - 1));
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log(`║${header}${pad}║`);
  console.log('╚══════════════════════════════════════════════════════════════╝');

  printSection('Quality rates');
  printKv('adoptionRate', pct(analysis.adoptionRate));
  printKv('contractCoverageRate', pct(analysis.contractCoverageRate));
  printKv('forceAcceptRate', pct(analysis.forceAcceptRate));
  printKv('bootedRate', analysis.bootedRate === null ? '—' : pct(analysis.bootedRate));
  printKv('falseWarningRate (other)', pct(analysis.falseWarningRate));
  printKv('boxEscapeRate', pct(analysis.boxEscapeRate));
  printKv('missedAdoptionRate', pct(analysis.missedAdoptionRate));

  printSection('Token / tool-call percentiles');
  printKv('tokenP50', num(analysis.tokenP50));
  printKv('tokenP90', num(analysis.tokenP90));
  printKv('toolCallP50', num(analysis.toolCallP50));
  printKv('juiceP50', analysis.juiceP50 === null ? '—' : num(analysis.juiceP50));

  printSection('Engine breakdown');
  const engineEntries = Object.entries(analysis.byEngine).sort((a, b) => b[1] - a[1]);
  if (engineEntries.length === 0) {
    console.log('  (none)');
  } else {
    for (const [engine, count] of engineEntries) {
      printKv(engine, String(count));
    }
  }

  printSection('Genre breakdown');
  const genreEntries = Object.entries(analysis.byGenre).sort((a, b) => b[1] - a[1]);
  if (genreEntries.length === 0) {
    console.log('  (none)');
  } else {
    for (const [genre, count] of genreEntries) {
      printKv(genre, String(count));
    }
  }

  printSection('Top invariant warnings');
  const warnEntries = Object.entries(analysis.invariantWarningFreq).sort((a, b) => b[1] - a[1]);
  if (warnEntries.length === 0) {
    console.log('  (none)');
  } else {
    for (const [warning, count] of warnEntries.slice(0, 10)) {
      printKv(warning, String(count));
    }
  }

  printSection('Flags');
  if (analysis.flags.length === 0) {
    console.log('  (none)');
  } else {
    for (const flag of analysis.flags) {
      console.log(`  !  ${flag}`);
    }
  }

  console.log('');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const connectionString = process.env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL;

  const sql = postgres(connectionString, { max: 5 });

  try {
    type MetricsRow = { report: unknown };

    const rows = await sql<MetricsRow[]>`
      SELECT report
      FROM run_quality_metrics
      WHERE report IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 500
    `;

    if (rows.length === 0) {
      console.log('No run_quality_metrics rows with a populated report found.');
      console.log('Nothing to analyze — run the generation worker to produce data.');
      return;
    }

    const reports: BuildReport[] = rows.map((row, i) => {
      const r = row.report;
      if (typeof r !== 'object' || r === null) {
        throw new Error(`Row ${i}: report field is not an object — got ${typeof r}`);
      }
      // Structural cast: the DB owns the schema. Missing optional fields surface
      // as undefined and are handled gracefully by analyzeReports().
      return r as BuildReport;
    });

    const analysis = analyzeReports(reports);
    printAnalysis(analysis, rows.length);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err: unknown) => {
  console.error('analyze-runs: fatal error');
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
