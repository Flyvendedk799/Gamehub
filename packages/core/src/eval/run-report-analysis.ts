/**
 * Run-report analysis harness (Phase 5.7 / audit wave 8).
 *
 * Pure, dependency-free module that takes an array of per-run BuildReports
 * (persisted to `run_quality_metrics.report` jsonb) and surfaces engine
 * quality / coverage signals.
 *
 * No I/O. No imports. Callers inject the raw array; this module does the
 * compute and returns a RunAnalysis value.
 */

// ---------------------------------------------------------------------------
// BuildReport — one record per game-generation run
// ---------------------------------------------------------------------------

export interface BuildReport {
  genre: string | null;
  engine: 'three' | 'phaser' | null;
  dimensions: string | null;
  winCondition: string | null;
  fileCount: number;
  shipReason: string; // 'passed' | 'no_verdict' | 'repair_exhausted' | 'budget_exhausted' | ...
  forceAccept: boolean;
  repairRounds: number;
  runtimeBooted: boolean | null;
  juiceScore: number | null;
  playbookPass: number;
  playbookTotal: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  toolCalls: Record<string, number>;
  toolCallTotal: number;
  skillsViewed: string[]; // e.g. ['phaser/wave-spawner.js']
  invariantWarnings: string[]; // e.g. ['escalation','controls']
  contractAuthored: boolean;
  tweakSchemaDeclared: boolean;
  strReplaceFailures: number;
  // OPTIONAL fields added by later phases — present when available:
  recommendedButUnused?: string[]; // skills the engine recommended but the agent never opened
  engineEscaped?: boolean; // declared an engine but built with a different runtime (decoy)
  capabilities?: {
    escalates?: boolean;
    hasEnemies?: boolean;
    hasProgression?: boolean;
    hasNarrative?: boolean;
    hasEconomy?: boolean;
    procedural?: boolean;
    controlScheme?: string;
    mechanics?: string[];
  } | null;
}

// ---------------------------------------------------------------------------
// RunAnalysis — what analyzeReports() returns
// ---------------------------------------------------------------------------

export interface RunAnalysis {
  /** Fraction of runs whose capabilities implied a recommendable system AND
   *  the agent opened ≥1 matching skill. 0 when no qualifying run exists. */
  adoptionRate: number;
  /** Fraction of all runs where contractAuthored === true. */
  contractCoverageRate: number;
  /** Fraction of all runs where forceAccept === true. */
  forceAcceptRate: number;
  /** Fraction of all runs where runtimeBooted === true (measured runs only);
   *  null when no run measured a boot verdict. */
  bootedRate: number | null;
  /** Fraction of genre==='other' runs that had ≥1 invariantWarning. */
  falseWarningRate: number;
  /** Fraction of all runs where engineEscaped === true. */
  boxEscapeRate: number;
  /** Fraction of runs where recommendedButUnused?.length > 0. */
  missedAdoptionRate: number;
  /** Median totalTokens across all runs; 0 when no runs. */
  tokenP50: number;
  /** 90th-percentile totalTokens; 0 when no runs. */
  tokenP90: number;
  /** Median toolCallTotal; 0 when no runs. */
  toolCallP50: number;
  /** Median juiceScore across runs that measured one; null when none. */
  juiceP50: number | null;
  /** Per-invariant-warning occurrence count across all runs. */
  invariantWarningFreq: Record<string, number>;
  /** Run count by engine key. */
  byEngine: Record<string, number>;
  /** Run count by genre (null → '(none)'). */
  byGenre: Record<string, number>;
  /** Human-readable issue flags raised by the analysis. */
  flags: string[];
}

// ---------------------------------------------------------------------------
// Per-report detectors
// ---------------------------------------------------------------------------

/** The engine recommended skills but the agent never opened any of them. */
export function isMissedAdoption(r: BuildReport): boolean {
  return (r.recommendedButUnused?.length ?? 0) > 0;
}

/** The agent declared an engine but the generated artifact used a different
 *  runtime (engine-escaped / decoy). */
export function isBoxEscape(r: BuildReport): boolean {
  return r.engineEscaped === true;
}

/** genre==='other' run that fired ≥1 invariant warning — potentially a false
 *  positive because the other-genre path has no canonical contract to check
 *  against. */
export function isFalseWarningRisk(r: BuildReport): boolean {
  return r.genre === 'other' && r.invariantWarnings.length > 0;
}

/** The run shipped without a deterministic verdict or without the artifact
 *  booting — the pass signal is unverified. */
export function isUnverified(r: BuildReport): boolean {
  return r.shipReason === 'no_verdict' || r.runtimeBooted !== true;
}

/** The run consumed more tokens than the supplied p90 threshold. */
export function isCostly(r: BuildReport, p90Tokens: number): boolean {
  return r.totalTokens > p90Tokens;
}

// ---------------------------------------------------------------------------
// Capability → expected skill-name substrings
// ---------------------------------------------------------------------------

/** Returns the list of skill-name substrings expected for a report's
 *  capabilities. A non-empty list means the run is "capability-qualifying"
 *  (i.e., it had at least one capability that implies a recommendable system). */
function expectedSkillSubstrings(r: BuildReport): string[] {
  const caps = r.capabilities;
  if (caps == null) return [];
  const expected: string[] = [];
  if (caps.hasEnemies === true) expected.push('enemy-ai');
  if (caps.escalates === true) expected.push('wave-spawner');
  if (caps.hasProgression === true) expected.push('level-orchestrator', 'save-state');
  if (caps.procedural === true) expected.push('procedural-gen');
  if (caps.hasNarrative === true) expected.push('dialog-flow');
  if (caps.hasEconomy === true) expected.push('economy-system');
  return expected;
}

/** True when the agent opened ≥1 skill whose path contains at least one of
 *  the expected substrings. */
function agentAdoptedSkill(skillsViewed: string[], expectedSubstrings: string[]): boolean {
  if (expectedSubstrings.length === 0) return false;
  return skillsViewed.some((skill) => expectedSubstrings.some((sub) => skill.includes(sub)));
}

// ---------------------------------------------------------------------------
// Percentile helper
// ---------------------------------------------------------------------------

/** Returns the value at percentile p (0–100) of a sorted numeric array.
 *  Returns 0 for an empty array. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  const frac = idx - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

// ---------------------------------------------------------------------------
// analyzeReports — main entry point
// ---------------------------------------------------------------------------

export function analyzeReports(reports: BuildReport[]): RunAnalysis {
  const total = reports.length;

  if (total === 0) {
    return {
      adoptionRate: 0,
      contractCoverageRate: 0,
      forceAcceptRate: 0,
      bootedRate: null,
      falseWarningRate: 0,
      boxEscapeRate: 0,
      missedAdoptionRate: 0,
      tokenP50: 0,
      tokenP90: 0,
      toolCallP50: 0,
      juiceP50: null,
      invariantWarningFreq: {},
      byEngine: {},
      byGenre: {},
      flags: ['No runs to analyze.'],
    };
  }

  // Adoption rate — only over "capability-qualifying" runs
  let adoptionQualifying = 0;
  let adoptionHit = 0;

  let contractCount = 0;
  let forceAcceptCount = 0;
  let bootMeasured = 0;
  let bootedCount = 0;
  let boxEscapeCount = 0;
  let missedAdoptionCount = 0;

  // false warning rate — over genre==='other' only
  let otherGenreCount = 0;
  let falseWarningCount = 0;

  const invariantWarningFreq: Record<string, number> = {};
  const byEngine: Record<string, number> = {};
  const byGenre: Record<string, number> = {};

  const tokensSorted: number[] = [];
  const toolCallsSorted: number[] = [];
  const juiceScores: number[] = [];

  for (const r of reports) {
    // Token / tool-call arrays (to be sorted later for percentiles)
    tokensSorted.push(r.totalTokens);
    toolCallsSorted.push(r.toolCallTotal);
    if (r.juiceScore !== null) juiceScores.push(r.juiceScore);

    // Contract coverage
    if (r.contractAuthored) contractCount += 1;

    // Force-accept
    if (r.forceAccept) forceAcceptCount += 1;

    // Boot verdict
    if (r.runtimeBooted !== null) {
      bootMeasured += 1;
      if (r.runtimeBooted) bootedCount += 1;
    }

    // Box escape
    if (isBoxEscape(r)) boxEscapeCount += 1;

    // Missed adoption
    if (isMissedAdoption(r)) missedAdoptionCount += 1;

    // False warning risk — only counts over genre==='other'
    if (r.genre === 'other') {
      otherGenreCount += 1;
      if (r.invariantWarnings.length > 0) falseWarningCount += 1;
    }

    // Invariant warning frequency
    for (const w of r.invariantWarnings) {
      invariantWarningFreq[w] = (invariantWarningFreq[w] ?? 0) + 1;
    }

    // Engine breakdown
    const engineKey = r.engine ?? '(none)';
    byEngine[engineKey] = (byEngine[engineKey] ?? 0) + 1;

    // Genre breakdown
    const genreKey = r.genre ?? '(none)';
    byGenre[genreKey] = (byGenre[genreKey] ?? 0) + 1;

    // Adoption rate computation
    const expectedSubstrings = expectedSkillSubstrings(r);
    if (expectedSubstrings.length > 0) {
      adoptionQualifying += 1;
      if (agentAdoptedSkill(r.skillsViewed, expectedSubstrings)) {
        adoptionHit += 1;
      }
    }
  }

  // Sort arrays for percentiles
  tokensSorted.sort((a, b) => a - b);
  toolCallsSorted.sort((a, b) => a - b);
  juiceScores.sort((a, b) => a - b);

  const adoptionRate = adoptionQualifying === 0 ? 0 : adoptionHit / adoptionQualifying;
  const contractCoverageRate = contractCount / total;
  const forceAcceptRate = forceAcceptCount / total;
  const bootedRate = bootMeasured === 0 ? null : bootedCount / bootMeasured;
  const falseWarningRate = otherGenreCount === 0 ? 0 : falseWarningCount / otherGenreCount;
  const boxEscapeRate = boxEscapeCount / total;
  const missedAdoptionRate = missedAdoptionCount / total;

  const tokenP50 = percentile(tokensSorted, 50);
  const tokenP90 = percentile(tokensSorted, 90);
  const toolCallP50 = percentile(toolCallsSorted, 50);
  const juiceP50 = juiceScores.length === 0 ? null : percentile(juiceScores, 50);

  // Build flags
  const flags: string[] = [];

  if (missedAdoptionCount > 0) {
    flags.push(
      `${missedAdoptionCount} run${missedAdoptionCount !== 1 ? 's' : ''} re-derived a recommendable system (missed adoption).`,
    );
  }
  if (boxEscapeCount > 0) {
    flags.push(
      `${boxEscapeCount} run${boxEscapeCount !== 1 ? 's' : ''} escaped declared engine (engine-escaped / decoy).`,
    );
  }
  if (falseWarningCount > 0 && otherGenreCount > 0) {
    flags.push(
      `${falseWarningCount}/${otherGenreCount} genre=other runs fired invariant warnings (possible false positives).`,
    );
  }
  if (adoptionQualifying > 0 && adoptionRate < 0.5) {
    flags.push(
      `Low skill-adoption rate: ${(adoptionRate * 100).toFixed(1)}% of capability-qualifying runs opened a matching skill.`,
    );
  }
  if (contractCoverageRate < 0.8 && total >= 5) {
    flags.push(
      `Contract coverage is low: ${(contractCoverageRate * 100).toFixed(1)}% of runs authored a playtest contract.`,
    );
  }
  if (bootedRate !== null && bootedRate < 0.7) {
    flags.push(
      `Boot rate is low: ${(bootedRate * 100).toFixed(1)}% of measured runs booted successfully.`,
    );
  }
  if (forceAcceptRate > 0.2 && total >= 5) {
    flags.push(
      `High force-accept rate: ${(forceAcceptRate * 100).toFixed(1)}% of runs shipped without passing the deterministic gate.`,
    );
  }

  return {
    adoptionRate,
    contractCoverageRate,
    forceAcceptRate,
    bootedRate,
    falseWarningRate,
    boxEscapeRate,
    missedAdoptionRate,
    tokenP50,
    tokenP90,
    toolCallP50,
    juiceP50,
    invariantWarningFreq,
    byEngine,
    byGenre,
    flags,
  };
}
