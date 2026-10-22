/** Offline only: prepares a randomized, paired experiment and reports supplied evidence.
 * This command never imports a provider adapter or starts a generation.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EvalFixture } from '../src/eval/fixture';

export const BENCHMARK_PATHS = ['codex', 'claude', 'gemini-antigravity'] as const;
export function buildBenchmarkPlan(
  fixtures: ReadonlyArray<{ slug: string; brief: string }>,
  seed = 'playerzero-parity-v1',
) {
  const cases = fixtures.flatMap((fixture) =>
    BENCHMARK_PATHS.flatMap((providerPath) =>
      [1, 2, 3].map((repeat) => ({
        id: `${fixture.slug}--${providerPath}--${repeat}`,
        fixture: fixture.slug,
        providerPath,
        repeat,
        brief: fixture.brief,
        edit: 'Add a clearly visible pause/resume control. Preserve the core mechanic, controls, art direction and existing win/lose conditions.',
        recovery:
          'Restore the previous verified version, confirm it still plays, then return to the edited version.',
        evidenceFile: `results/${fixture.slug}--${providerPath}--${repeat}.json`,
      })),
    ),
  );
  cases.sort((a, b) =>
    createHash('sha256')
      .update(`${seed}:${a.id}`)
      .digest('hex')
      .localeCompare(createHash('sha256').update(`${seed}:${b.id}`).digest('hex')),
  );
  return {
    schemaVersion: 1,
    seed,
    status: 'prepared_not_run',
    policy: {
      equalBudget: true,
      independentProjects: true,
      silentProviderFallback: false,
      includeFailures: true,
      paidRunsExecutedByPreparation: 0,
    },
    // Fill these before running. Unknown prices or models must stay unknown.
    configuration: BENCHMARK_PATHS.map((providerPath) => ({
      providerPath,
      exactModelId: null,
      maxTokensPerRun: null,
      maxSpendUsd: null,
      reasoning: null,
      endpointLabel: null,
    })),
    evidenceRequired: [
      'exactModelId',
      'commit',
      'artifactHash',
      'boot',
      'inputBehavior',
      'editRegression',
      'restore',
      'publishedArtifactHash',
      'publicationVerified',
      'screenshots:title,play,failure-or-win',
      'audioAudible',
      'elapsedMs',
      'costUsd',
      'tokens',
      'repairCount',
      'failureCause',
      'blindReview:fidelity,readability,feel,originality,replay',
    ],
    cases,
  };
}

export function prepareBenchmark(root: string, output: string): number {
  const fixtureDir = resolve(root, 'evals/fixtures');
  const fixtures = readdirSync(fixtureDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => EvalFixture.parse(JSON.parse(readFileSync(resolve(fixtureDir, name), 'utf8'))));
  const plan = buildBenchmarkPlan(fixtures);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx' });
  return plan.cases.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const output = resolve(root, process.argv[2] ?? 'evals/provider-parity/plan.json');
  const count = prepareBenchmark(root, output);
  process.stdout.write(
    `Prepared ${count} cases at ${output}. No generations or paid calls were made.\n`,
  );
}
