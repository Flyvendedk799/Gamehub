/**
 * may9 Phase 14 — eval runner assertion tests.
 *
 * Covers each assertion class against canonical fixture shapes so a
 * future contributor adding a new field gets immediate guidance on
 * how it behaves.
 */
import { describe, expect, it } from 'vitest';
import { EvalFixture } from './fixture';
import { type RunObservation, evaluateFixture } from './runner';

const FPS_FIXTURE: EvalFixture = EvalFixture.parse({
  name: 'FPS Wave Defense',
  slug: 'fps-wave-defense',
  description: 'replay of the May-8 baseline FPS run',
  brief:
    'Create a simple 3D first-person shooter where the player fights through waves of enemies.',
  playtestPlaybook: 'fps',
  assertions: {
    expectedEngine: 'three',
    expectedGenre: 'fps',
    requiredFiles: ['index.html'],
    requiredAudio: true,
    maxInputTokens: 1_400_000,
    maxStrReplaceFailureRate: 0.05,
    maxSetTodosCalls: 8,
    minValidateGameSceneCalls: 1,
    minPlaytestGameCalls: 1,
    maxRenderPreviewCalls: 0,
    maxCorrections: 2,
  },
});

const PASSING_OBS: RunObservation = {
  engine: 'three',
  genre: 'fps',
  inputTokens: 1_000_000,
  outputTokens: 50_000,
  cachedInputTokens: 750_000,
  toolCounts: {
    str_replace_based_edit_tool: 80,
    set_todos: 4,
    validate_game_scene: 2,
    playtest_game: 1,
    render_preview: 0,
    generate_audio_asset: 1,
  },
  strReplaceFailures: 2,
  filePaths: ['index.html', 'src/scene.js'],
  snapshotCount: 1,
  correctionCount: 1,
};

describe('evaluateFixture — passing case', () => {
  it('PASSES when every assertion holds', () => {
    const r = evaluateFixture(FPS_FIXTURE, PASSING_OBS);
    expect(r.pass).toBe(true);
    expect(r.failures).toEqual([]);
    expect(r.observed.engine).toBe('three');
    expect(r.observed.cacheHitRate).toBeCloseTo(0.75, 2);
  });
});

describe('evaluateFixture — engine + genre assertions', () => {
  it('FAILS when engine != expected (fps-on-phaser class)', () => {
    const r = evaluateFixture(FPS_FIXTURE, { ...PASSING_OBS, engine: 'phaser' });
    expect(r.pass).toBe(false);
    expect(r.failures.join(' ')).toContain('engine: expected');
  });

  it('FAILS when genre != expected', () => {
    const r = evaluateFixture(FPS_FIXTURE, { ...PASSING_OBS, genre: 'platformer' });
    expect(r.pass).toBe(false);
    expect(r.failures.join(' ')).toContain('genre: expected');
  });
});

describe('evaluateFixture — file + audio assertions', () => {
  it('FAILS when a required file is missing', () => {
    const r = evaluateFixture(FPS_FIXTURE, { ...PASSING_OBS, filePaths: [] });
    expect(r.pass).toBe(false);
    expect(r.failures.join(' ')).toContain("'index.html' is missing");
  });

  it('FAILS when requiredAudio=true and no audio calls recorded', () => {
    const r = evaluateFixture(FPS_FIXTURE, {
      ...PASSING_OBS,
      toolCounts: { ...PASSING_OBS.toolCounts, generate_audio_asset: 0 },
    });
    expect(r.pass).toBe(false);
    expect(r.failures.join(' ')).toContain('requiredAudio');
  });
});

describe('evaluateFixture — token + count caps', () => {
  it('FAILS on the FPS-baseline 4.78M input-tokens case', () => {
    const r = evaluateFixture(FPS_FIXTURE, { ...PASSING_OBS, inputTokens: 4_780_000 });
    expect(r.pass).toBe(false);
    expect(r.failures.join(' ')).toContain('inputTokens');
  });

  it('FAILS on the FPS-baseline 93 set_todos case', () => {
    const r = evaluateFixture(FPS_FIXTURE, {
      ...PASSING_OBS,
      toolCounts: { ...PASSING_OBS.toolCounts, set_todos: 93 },
    });
    expect(r.pass).toBe(false);
    expect(r.failures.join(' ')).toContain('set_todos calls: 93');
  });

  it('FAILS when validate_game_scene was never called (FPS D1)', () => {
    const r = evaluateFixture(FPS_FIXTURE, {
      ...PASSING_OBS,
      toolCounts: { ...PASSING_OBS.toolCounts, validate_game_scene: 0 },
    });
    expect(r.pass).toBe(false);
    expect(r.failures.join(' ')).toContain('validate_game_scene calls: 0');
  });

  it('FAILS when playtest_game was never called (FPS D1)', () => {
    const r = evaluateFixture(FPS_FIXTURE, {
      ...PASSING_OBS,
      toolCounts: { ...PASSING_OBS.toolCounts, playtest_game: 0 },
    });
    expect(r.pass).toBe(false);
    expect(r.failures.join(' ')).toContain('playtest_game calls: 0');
  });

  it('FAILS when render_preview was called in game mode (FPS D3)', () => {
    const r = evaluateFixture(FPS_FIXTURE, {
      ...PASSING_OBS,
      toolCounts: { ...PASSING_OBS.toolCounts, render_preview: 5 },
    });
    expect(r.pass).toBe(false);
    expect(r.failures.join(' ')).toContain('render_preview calls: 5');
  });

  it('FAILS on the brawler 6-correction baseline', () => {
    const r = evaluateFixture(FPS_FIXTURE, { ...PASSING_OBS, correctionCount: 6 });
    expect(r.pass).toBe(false);
    expect(r.failures.join(' ')).toContain('corrections: 6');
  });
});

describe('evaluateFixture — Phase 5.3 output-quality (runtime boot) gate', () => {
  const BOOT_FIXTURE: EvalFixture = EvalFixture.parse({
    name: 'Platformer boot gate',
    slug: 'platformer-boot',
    description: 'requires the artifact to actually boot',
    brief: 'Make a 2D platformer that boots.',
    assertions: {
      requiredAudio: false,
      minValidateGameSceneCalls: 0,
      minPlaytestGameCalls: 0,
      requireRuntimeBoot: true,
    },
  });

  // A process-healthy observation with NO runtime verdict; the boot gate
  // is what the cases below toggle.
  const HEALTHY_OBS: RunObservation = PASSING_OBS;

  it('PASSES when the artifact booted clean (window.__game present, no errors)', () => {
    const r = evaluateFixture(BOOT_FIXTURE, {
      ...HEALTHY_OBS,
      runtimeVerify: { booted: true, fatalErrors: [] },
    });
    expect(r.pass).toBe(true);
    expect(r.observed.runtimeBoot).toBe('boot');
  });

  it('FAILS a throw-on-boot artifact even when every process proxy looks healthy', () => {
    const r = evaluateFixture(BOOT_FIXTURE, {
      ...HEALTHY_OBS,
      runtimeVerify: { booted: false, fatalErrors: ['TypeError: cannot read x of undefined'] },
    });
    expect(r.pass).toBe(false);
    expect(r.observed.runtimeBoot).toBe('fail');
    expect(r.failures.join(' ')).toMatch(/did not boot/i);
  });

  it('FAILS when window.__game appeared but fatal boot errors were captured', () => {
    const r = evaluateFixture(BOOT_FIXTURE, {
      ...HEALTHY_OBS,
      runtimeVerify: { booted: true, fatalErrors: ['Uncaught RangeError'] },
    });
    expect(r.pass).toBe(false);
    expect(r.failures.join(' ')).toContain('fatal boot error');
  });

  it('FAILS when requireRuntimeBoot=true but no verdict was recorded', () => {
    const r = evaluateFixture(BOOT_FIXTURE, HEALTHY_OBS);
    expect(r.pass).toBe(false);
    expect(r.observed.runtimeBoot).toBe('n/a');
    expect(r.failures.join(' ')).toContain('no runtime-verify verdict');
  });

  it('does NOT gate on boot when requireRuntimeBoot is false (default)', () => {
    const r = evaluateFixture(FPS_FIXTURE, PASSING_OBS);
    expect(r.pass).toBe(true);
    expect(r.observed.runtimeBoot).toBe('n/a');
  });
});

describe('evaluateFixture — Phase 5.5 juice/density floor', () => {
  const JUICE_FIXTURE: EvalFixture = EvalFixture.parse({
    name: 'Platformer juice floor',
    slug: 'platformer-juice',
    description: 'requires the artifact to actually animate',
    brief: 'Make a 2D platformer with real motion.',
    assertions: {
      requiredAudio: false,
      minValidateGameSceneCalls: 0,
      minPlaytestGameCalls: 0,
      requireJuice: 50,
    },
  });

  it('PASSES when the measured juiceScore meets the floor', () => {
    const r = evaluateFixture(JUICE_FIXTURE, {
      ...PASSING_OBS,
      runtimeVerify: { booted: true, fatalErrors: [], juiceScore: 120 },
    });
    expect(r.pass).toBe(true);
    expect(r.observed.juiceScore).toBe(120);
  });

  it('PASSES exactly at the floor (>= is inclusive)', () => {
    const r = evaluateFixture(JUICE_FIXTURE, {
      ...PASSING_OBS,
      runtimeVerify: { booted: true, fatalErrors: [], juiceScore: 50 },
    });
    expect(r.pass).toBe(true);
  });

  it('FAILS a static no-animation game whose juiceScore is below the floor', () => {
    const r = evaluateFixture(JUICE_FIXTURE, {
      ...PASSING_OBS,
      runtimeVerify: { booted: true, fatalErrors: [], juiceScore: 3 },
    });
    expect(r.pass).toBe(false);
    expect(r.observed.juiceScore).toBe(3);
    expect(r.failures.join(' ')).toMatch(/too static/i);
  });

  it('FAILS when requireJuice is set but the verdict carried no juiceScore', () => {
    const r = evaluateFixture(JUICE_FIXTURE, {
      ...PASSING_OBS,
      runtimeVerify: { booted: true, fatalErrors: [] },
    });
    expect(r.pass).toBe(false);
    expect(r.observed.juiceScore).toBeNull();
    expect(r.failures.join(' ')).toContain('no juiceScore');
  });

  it('FAILS when requireJuice is set but no runtime-verify verdict was recorded', () => {
    const r = evaluateFixture(JUICE_FIXTURE, PASSING_OBS);
    expect(r.pass).toBe(false);
    expect(r.observed.juiceScore).toBeNull();
    expect(r.failures.join(' ')).toMatch(/no runtime-verify verdict/);
  });

  it('does NOT gate on juice when requireJuice is 0 (default) — strictly opt-out', () => {
    const r = evaluateFixture(FPS_FIXTURE, {
      ...PASSING_OBS,
      runtimeVerify: { booted: true, fatalErrors: [], juiceScore: 0 },
    });
    expect(r.pass).toBe(true);
    // The score still surfaces into the report even when no floor is asserted.
    expect(r.observed.juiceScore).toBe(0);
  });
});

describe('evaluateFixture — str_replace failure rate', () => {
  it('FAILS at the FPS 19% miss-rate baseline', () => {
    const r = evaluateFixture(FPS_FIXTURE, {
      ...PASSING_OBS,
      toolCounts: { ...PASSING_OBS.toolCounts, str_replace_based_edit_tool: 100 },
      strReplaceFailures: 19,
    });
    expect(r.pass).toBe(false);
    expect(r.failures.join(' ')).toContain('strReplaceFailureRate');
  });

  it('PASSES at the post-V2 5% target', () => {
    const r = evaluateFixture(FPS_FIXTURE, {
      ...PASSING_OBS,
      toolCounts: { ...PASSING_OBS.toolCounts, str_replace_based_edit_tool: 100 },
      strReplaceFailures: 5,
    });
    expect(r.pass).toBe(true);
  });
});
