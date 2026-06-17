/**
 * Phase 5.1 — `pnpm eval:games` CLI driver.
 *
 * A HERMETIC, OFFLINE eval runner. It does NOT call a provider, hit the
 * network, or touch a database. It:
 *   1. loads every fixture under `evals/fixtures/*.json`,
 *   2. for each fixture, loads its recorded observation from
 *      `evals/recordings/<slug>.json` (a frozen RunObservation captured
 *      from a prior real run),
 *   3. replays it through the SAME pure `evaluateFixture()` the live
 *      worker backend would use,
 *   4. writes a markdown report to `evals/runs/<date>.md`,
 *   5. EXITS NON-ZERO when any recording violates its fixture's
 *      assertions — so CI blocks a generation-quality regression.
 *
 * Fixtures with no recording are reported as FAIL ("no recording") rather
 * than silently skipped: an un-recorded golden prompt is itself a gap.
 * The good golden set committed to the repo has a recording for every
 * fixture and exits 0.
 *
 * Usage:
 *   pnpm eval:games                # default dirs, write report, exit code
 *   pnpm eval:games --no-write     # skip writing the report file
 *   pnpm eval:games --evals <dir>  # point at a different evals/ root
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import {
  type EvalFixture,
  EvalFixture as EvalFixtureParser,
  type EvalReport,
  type EvalResult,
  type RunObservation,
  evaluateFixture,
  parseEvalRecording,
  renderEvalReport,
} from '../src/eval/index.js';

interface CliOptions {
  evalsDir: string;
  write: boolean;
}

function parseArgs(argv: ReadonlyArray<string>, defaultEvalsDir: string): CliOptions {
  let evalsDir = defaultEvalsDir;
  let write = true;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--no-write') {
      write = false;
    } else if (arg === '--evals') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('--evals requires a directory argument');
      evalsDir = path.resolve(next);
      i++;
    } else if (arg !== undefined && arg.startsWith('--evals=')) {
      evalsDir = path.resolve(arg.slice('--evals='.length));
    } else {
      throw new Error(`Unknown argument: ${String(arg)}`);
    }
  }
  return { evalsDir, write };
}

function loadFixtures(fixturesDir: string): EvalFixture[] {
  if (!fs.existsSync(fixturesDir)) {
    throw new Error(`fixtures dir not found: ${fixturesDir}`);
  }
  const files = fs
    .readdirSync(fixturesDir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  const fixtures: EvalFixture[] = [];
  for (const f of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(fixturesDir, f), 'utf8')) as unknown;
    fixtures.push(EvalFixtureParser.parse(raw));
  }
  return fixtures;
}

/** Load the recording for a fixture slug, or null when none is committed. */
function loadRecording(recordingsDir: string, slug: string): RunObservation | null {
  const file = path.join(recordingsDir, `${slug}.json`);
  if (!fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  const rec = parseEvalRecording(raw);
  if (rec.fixtureSlug !== slug) {
    throw new Error(
      `recording ${slug}.json declares fixtureSlug='${rec.fixtureSlug}' (expected '${slug}')`,
    );
  }
  return rec.observation;
}

/** A FAIL result for a fixture that has no committed recording. */
function missingRecordingResult(fixture: EvalFixture): EvalResult {
  return {
    fixture,
    pass: false,
    durationMs: 0,
    failures: [`no recording committed at evals/recordings/${fixture.slug}.json`],
    observed: {
      engine: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheHitRate: 0,
      setTodosCalls: 0,
      validateGameSceneCalls: 0,
      playtestGameCalls: 0,
      renderPreviewCalls: 0,
      strReplaceCalls: 0,
      audioCalls: 0,
      snapshotCount: 0,
      correctionCount: 0,
      runtimeBoot: 'n/a',
    },
  };
}

/** Pure orchestration: given fixtures + a recording loader, produce the
 *  report. Exposed so a test can drive it without process.exit / fs. */
export function buildReport(
  fixtures: ReadonlyArray<EvalFixture>,
  loadObservation: (slug: string) => RunObservation | null,
  generatedAt: string,
): EvalReport {
  const results: EvalResult[] = [];
  for (const fixture of fixtures) {
    const observation = loadObservation(fixture.slug);
    results.push(
      observation === null
        ? missingRecordingResult(fixture)
        : evaluateFixture(fixture, observation),
    );
  }
  const passed = results.filter((r) => r.pass).length;
  return {
    generatedAt,
    results,
    summary: { total: results.length, passed, failed: results.length - passed },
  };
}

function main(): number {
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const defaultEvalsDir = path.resolve(here, '..', '..', '..', 'evals');
  const opts = parseArgs(process.argv.slice(2), defaultEvalsDir);

  const fixturesDir = path.join(opts.evalsDir, 'fixtures');
  const recordingsDir = path.join(opts.evalsDir, 'recordings');
  const runsDir = path.join(opts.evalsDir, 'runs');

  const fixtures = loadFixtures(fixturesDir);
  if (fixtures.length === 0) {
    // No fixtures at all is itself a failure — an empty golden set passes
    // nothing, so it must not exit 0 vacuously.
    process.stderr.write(`No fixtures found under ${fixturesDir}\n`);
    return 1;
  }

  const generatedAt = new Date().toISOString().slice(0, 10);
  const report = buildReport(fixtures, (slug) => loadRecording(recordingsDir, slug), generatedAt);
  const markdown = renderEvalReport(report);

  if (opts.write) {
    fs.mkdirSync(runsDir, { recursive: true });
    const outPath = path.join(runsDir, `${generatedAt}.md`);
    fs.writeFileSync(outPath, markdown, 'utf8');
    process.stdout.write(`Wrote ${path.relative(process.cwd(), outPath)}\n`);
  }

  process.stdout.write(
    `eval:games — ${report.summary.passed}/${report.summary.total} fixtures passed` +
      ` (${report.summary.failed} failed)\n`,
  );
  for (const r of report.results) {
    if (!r.pass) {
      process.stdout.write(`  ✗ ${r.fixture.slug}: ${r.failures.join('; ')}\n`);
    }
  }

  return report.summary.failed === 0 ? 0 : 1;
}

// Run only when invoked directly (not when imported by a test).
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url);
if (invokedDirectly) {
  process.exit(main());
}
