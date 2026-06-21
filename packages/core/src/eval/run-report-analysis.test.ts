/**
 * Run-report analysis harness — Vitest tests.
 *
 * Uses hand-built fixture reports including two probes mirroring real runs:
 *   - "novel" run: genre=other, engineEscaped, invariantWarnings
 *   - "combat" run: capabilities with enemies/escalates, no matching skills opened
 */
import { describe, expect, it } from 'vitest';
import {
  type BuildReport,
  analyzeReports,
  isBoxEscape,
  isCostly,
  isFalseWarningRisk,
  isMissedAdoption,
  isUnverified,
} from './run-report-analysis';

// ---------------------------------------------------------------------------
// Fixture factory
// ---------------------------------------------------------------------------

function report(over: Partial<BuildReport> = {}): BuildReport {
  return {
    genre: 'topdown_arcade',
    engine: 'phaser',
    dimensions: '800x600',
    winCondition: 'reach score 100',
    fileCount: 3,
    shipReason: 'passed',
    forceAccept: false,
    repairRounds: 0,
    runtimeBooted: true,
    juiceScore: 80,
    playbookPass: 4,
    playbookTotal: 4,
    inputTokens: 10_000,
    outputTokens: 5_000,
    totalTokens: 15_000,
    toolCalls: { write_file: 3, str_replace: 2 },
    toolCallTotal: 5,
    skillsViewed: [],
    invariantWarnings: [],
    contractAuthored: true,
    tweakSchemaDeclared: false,
    strReplaceFailures: 0,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// "Novel" probe run (mirrors real run):
//   genre=other, contractAuthored, shipReason=passed, invariantWarnings fired,
//   engineEscaped=true, only juice skill viewed — no matching system skills.
// ---------------------------------------------------------------------------
const novelRun = report({
  genre: 'other',
  contractAuthored: true,
  shipReason: 'passed',
  forceAccept: false,
  invariantWarnings: ['score-or-state', 'controls'],
  engineEscaped: true,
  skillsViewed: ['phaser/juice-effects.js'],
  capabilities: null,
});

// ---------------------------------------------------------------------------
// "Combat" probe run (mirrors real run):
//   topdown_arcade, capabilities imply enemies+escalation, but the agent
//   only viewed juice — never opened wave-spawner or enemy-ai.
// ---------------------------------------------------------------------------
const combatRun = report({
  genre: 'topdown_arcade',
  contractAuthored: true,
  shipReason: 'passed',
  capabilities: { escalates: true, hasEnemies: true },
  skillsViewed: ['phaser/juice-effects.js'],
  recommendedButUnused: ['phaser/wave-spawner.js', 'phaser/enemy-ai.js'],
});

// ---------------------------------------------------------------------------
// Per-report detector tests
// ---------------------------------------------------------------------------

describe('isMissedAdoption', () => {
  it('returns true when recommendedButUnused is non-empty', () => {
    expect(isMissedAdoption(combatRun)).toBe(true);
  });

  it('returns false when recommendedButUnused is empty', () => {
    expect(isMissedAdoption(report({ recommendedButUnused: [] }))).toBe(false);
  });

  it('returns false when recommendedButUnused is absent', () => {
    expect(isMissedAdoption(report())).toBe(false);
  });
});

describe('isBoxEscape', () => {
  it('returns true when engineEscaped is true (novel run)', () => {
    expect(isBoxEscape(novelRun)).toBe(true);
  });

  it('returns false when engineEscaped is false', () => {
    expect(isBoxEscape(report({ engineEscaped: false }))).toBe(false);
  });

  it('returns false when engineEscaped is absent', () => {
    expect(isBoxEscape(report())).toBe(false);
  });
});

describe('isFalseWarningRisk', () => {
  it('returns true for genre=other with invariant warnings (novel run)', () => {
    expect(isFalseWarningRisk(novelRun)).toBe(true);
  });

  it('returns false for genre=other with no warnings', () => {
    expect(isFalseWarningRisk(report({ genre: 'other', invariantWarnings: [] }))).toBe(false);
  });

  it('returns false for a known genre even with warnings', () => {
    expect(
      isFalseWarningRisk(report({ genre: 'topdown_arcade', invariantWarnings: ['controls'] })),
    ).toBe(false);
  });
});

describe('isUnverified', () => {
  it('returns true when shipReason is no_verdict', () => {
    expect(isUnverified(report({ shipReason: 'no_verdict', runtimeBooted: true }))).toBe(true);
  });

  it('returns true when runtimeBooted is false', () => {
    expect(isUnverified(report({ shipReason: 'passed', runtimeBooted: false }))).toBe(true);
  });

  it('returns true when runtimeBooted is null', () => {
    expect(isUnverified(report({ shipReason: 'passed', runtimeBooted: null }))).toBe(true);
  });

  it('returns false for a clean passed run that booted', () => {
    expect(isUnverified(report({ shipReason: 'passed', runtimeBooted: true }))).toBe(false);
  });
});

describe('isCostly', () => {
  it('returns true when totalTokens exceeds the p90 threshold', () => {
    expect(isCostly(report({ totalTokens: 100_001 }), 100_000)).toBe(true);
  });

  it('returns false when totalTokens is at or below the threshold', () => {
    expect(isCostly(report({ totalTokens: 100_000 }), 100_000)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// analyzeReports aggregate tests
// ---------------------------------------------------------------------------

describe('analyzeReports — empty input', () => {
  it('returns a zero-state analysis with a No-runs flag', () => {
    const result = analyzeReports([]);
    expect(result.adoptionRate).toBe(0);
    expect(result.contractCoverageRate).toBe(0);
    expect(result.bootedRate).toBeNull();
    expect(result.flags).toContain('No runs to analyze.');
  });
});

describe('analyzeReports — boxEscapeRate', () => {
  it('counts engineEscaped=true runs (novel run)', () => {
    const result = analyzeReports([novelRun, combatRun]);
    // novelRun has engineEscaped=true; combatRun does not
    expect(result.boxEscapeRate).toBe(0.5);
  });
});

describe('analyzeReports — missedAdoptionRate', () => {
  it('counts runs with non-empty recommendedButUnused (combat run)', () => {
    const result = analyzeReports([novelRun, combatRun]);
    // combatRun has recommendedButUnused; novelRun does not
    expect(result.missedAdoptionRate).toBe(0.5);
  });
});

describe('analyzeReports — falseWarningRate', () => {
  it('is computed only over genre=other runs', () => {
    // novelRun is genre=other with warnings → 1/1 = 1.0
    const result = analyzeReports([novelRun, combatRun]);
    expect(result.falseWarningRate).toBe(1);
  });

  it('is 0 when no genre=other runs exist', () => {
    const result = analyzeReports([combatRun, report({ genre: 'fps' })]);
    expect(result.falseWarningRate).toBe(0);
  });

  it('is 0 when genre=other run has no warnings', () => {
    const quietOther = report({ genre: 'other', invariantWarnings: [] });
    const result = analyzeReports([quietOther]);
    expect(result.falseWarningRate).toBe(0);
  });
});

describe('analyzeReports — adoptionRate', () => {
  it('is 0 when no qualifying run opened a matching skill (combat run)', () => {
    // combatRun has hasEnemies+escalates but only opened juice-effects
    const result = analyzeReports([combatRun]);
    expect(result.adoptionRate).toBe(0);
  });

  it('is 1 when a qualifying run opens a matching skill', () => {
    const goodRun = report({
      capabilities: { hasEnemies: true },
      skillsViewed: ['phaser/enemy-ai.js'],
    });
    const result = analyzeReports([goodRun]);
    expect(result.adoptionRate).toBe(1);
  });

  it('is 0 when no run has capabilities that imply a system', () => {
    // novelRun has capabilities=null → no qualifying runs
    const result = analyzeReports([novelRun]);
    expect(result.adoptionRate).toBe(0);
  });

  it('partial adoption over mixed runs', () => {
    const goodRun = report({
      capabilities: { hasEnemies: true },
      skillsViewed: ['phaser/enemy-ai.js'],
    });
    // combatRun is qualifying but did NOT adopt
    const result = analyzeReports([goodRun, combatRun]);
    expect(result.adoptionRate).toBe(0.5);
  });
});

describe('analyzeReports — contractCoverageRate', () => {
  it('is 1 when all runs authored a contract', () => {
    const result = analyzeReports([novelRun, combatRun]);
    expect(result.contractCoverageRate).toBe(1);
  });

  it('counts correctly across mixed runs', () => {
    const noContract = report({ contractAuthored: false });
    const result = analyzeReports([novelRun, noContract]);
    expect(result.contractCoverageRate).toBe(0.5);
  });
});

describe('analyzeReports — percentiles', () => {
  it('computes tokenP50 and tokenP90 correctly', () => {
    const runs = [
      report({ totalTokens: 10_000 }),
      report({ totalTokens: 20_000 }),
      report({ totalTokens: 30_000 }),
      report({ totalTokens: 40_000 }),
      report({ totalTokens: 50_000 }),
    ];
    const result = analyzeReports(runs);
    expect(result.tokenP50).toBe(30_000);
    expect(result.tokenP90).toBeGreaterThan(40_000);
    expect(result.tokenP90).toBeLessThanOrEqual(50_000);
  });

  it('juiceP50 is null when no run measured juice', () => {
    const result = analyzeReports([report({ juiceScore: null }), report({ juiceScore: null })]);
    expect(result.juiceP50).toBeNull();
  });

  it('bootedRate is null when no run measured a boot verdict', () => {
    const result = analyzeReports([report({ runtimeBooted: null })]);
    expect(result.bootedRate).toBeNull();
  });
});

describe('analyzeReports — byEngine + byGenre breakdowns', () => {
  it('counts runs correctly per engine and genre', () => {
    const runs = [
      report({ engine: 'phaser', genre: 'topdown_arcade' }),
      report({ engine: 'three', genre: 'fps' }),
      report({ engine: 'phaser', genre: 'topdown_arcade' }),
      report({ engine: null, genre: null }),
    ];
    const result = analyzeReports(runs);
    expect(result.byEngine['phaser']).toBe(2);
    expect(result.byEngine['three']).toBe(1);
    expect(result.byEngine['(none)']).toBe(1);
    expect(result.byGenre['topdown_arcade']).toBe(2);
    expect(result.byGenre['fps']).toBe(1);
    expect(result.byGenre['(none)']).toBe(1);
  });
});

describe('analyzeReports — invariantWarningFreq', () => {
  it('tallies per-invariant counts across all runs', () => {
    const runs = [
      report({ invariantWarnings: ['controls', 'score-or-state'] }),
      report({ invariantWarnings: ['controls'] }),
      report({ invariantWarnings: [] }),
    ];
    const result = analyzeReports(runs);
    expect(result.invariantWarningFreq['controls']).toBe(2);
    expect(result.invariantWarningFreq['score-or-state']).toBe(1);
  });
});

describe('analyzeReports — flags', () => {
  it('raises missed-adoption flag for the combat probe run', () => {
    const result = analyzeReports([combatRun]);
    expect(result.flags.some((f) => f.includes('missed adoption'))).toBe(true);
  });

  it('raises engine-escaped flag for the novel probe run', () => {
    const result = analyzeReports([novelRun]);
    expect(result.flags.some((f) => f.includes('engine-escaped'))).toBe(true);
  });

  it('raises false-positive warning flag for the novel probe run', () => {
    const result = analyzeReports([novelRun]);
    expect(result.flags.some((f) => f.includes('genre=other'))).toBe(true);
  });
});
