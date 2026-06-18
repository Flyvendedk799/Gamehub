/**
 * Phase 5.1 / 5.2 — eval-games CLI behaviour tests.
 *
 * Covers:
 *   - the good golden set on disk parses + all 6 genres are present (5.2),
 *   - `buildReport` aggregates a violating recording into a FAIL so the
 *     CLI would exit non-zero (5.1 exit-code contract),
 *   - a missing recording is a FAIL, not a vacuous pass,
 *   - regressing the platformer recording (inverted/over-budget) drops the
 *     pass count (5.2).
 *
 * The orchestration is exercised through the exported pure `buildReport`
 * so we never spawn a subprocess or call process.exit in unit tests.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import { EvalFixture, type RunObservation, parseEvalRecording } from '../src/eval/index.js';
import { buildReport } from './eval-games.js';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const evalsDir = path.resolve(here, '..', '..', '..', 'evals');
const fixturesDir = path.join(evalsDir, 'fixtures');
const recordingsDir = path.join(evalsDir, 'recordings');

function loadAllFixtures(): EvalFixture[] {
  return fs
    .readdirSync(fixturesDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => EvalFixture.parse(JSON.parse(fs.readFileSync(path.join(fixturesDir, f), 'utf8'))));
}

function diskLoader(slug: string): RunObservation | null {
  const file = path.join(recordingsDir, `${slug}.json`);
  if (!fs.existsSync(file)) return null;
  return parseEvalRecording(JSON.parse(fs.readFileSync(file, 'utf8'))).observation;
}

describe('eval-games golden set on disk', () => {
  it('ships all 6 genres and they parse', () => {
    const fixtures = loadAllFixtures();
    const genres = new Set(fixtures.map((f) => f.assertions.expectedGenre));
    expect(fixtures.length).toBe(6);
    for (const g of ['platformer', 'fps', 'puzzle', 'topdown_arcade', 'runner', 'fighting']) {
      expect(genres.has(g)).toBe(true);
    }
  });

  it('the committed golden set fully passes (CLI would exit 0)', () => {
    const report = buildReport(loadAllFixtures(), diskLoader, '2026-06-17');
    expect(report.summary.failed).toBe(0);
    expect(report.summary.passed).toBe(report.summary.total);
  });
});

describe('eval-games exit-code contract', () => {
  const fixtures = loadAllFixtures();

  it('a violating recording → at least one FAIL (CLI would exit non-zero)', () => {
    // Regress the platformer recording: blow the input-token cap.
    const report = buildReport(
      fixtures,
      (slug) => {
        const obs = diskLoader(slug);
        if (slug === 'platformer' && obs) return { ...obs, inputTokens: 9_000_000 };
        return obs;
      },
      '2026-06-17',
    );
    expect(report.summary.failed).toBeGreaterThan(0);
    const platformer = report.results.find((r) => r.fixture.slug === 'platformer');
    expect(platformer?.pass).toBe(false);
    expect(platformer?.failures.join(' ')).toContain('inputTokens');
  });

  it('regressing the platformer recording drops the pass count', () => {
    const good = buildReport(fixtures, diskLoader, '2026-06-17');
    const regressed = buildReport(
      fixtures,
      (slug) => {
        const obs = diskLoader(slug);
        // Throw-on-boot: the output-quality (5.3) gate must catch it even
        // though every process proxy still looks healthy.
        if (slug === 'platformer' && obs) {
          return { ...obs, runtimeVerify: { booted: false, fatalErrors: ['TypeError on boot'] } };
        }
        return obs;
      },
      '2026-06-17',
    );
    expect(regressed.summary.passed).toBe(good.summary.passed - 1);
    const platformer = regressed.results.find((r) => r.fixture.slug === 'platformer');
    expect(platformer?.failures.join(' ')).toMatch(/did not boot/i);
  });

  it('a missing recording is a FAIL, not a vacuous pass', () => {
    const report = buildReport(
      fixtures,
      (slug) => (slug === 'fps' ? null : diskLoader(slug)),
      '2026-06-17',
    );
    const fps = report.results.find((r) => r.fixture.slug === 'fps');
    expect(fps?.pass).toBe(false);
    expect(fps?.failures.join(' ')).toContain('no recording');
  });
});
