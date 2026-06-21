/**
 * may9 Phase 4 — GameSpec round-trip + engine-fit gate.
 *
 * Covers the two-engine fit matrix (three vs phaser) and the FPS
 * vault-iteration coherence case (amend preserves untouched features
 * verbatim).
 */
import { describe, expect, it } from 'vitest';
import {
  GameCapabilities,
  GameSpec,
  applyGameSpecPatch,
  checkEngineFit,
  validateCapabilities,
} from './game-spec';

describe('GameSpec — Zod round-trip', () => {
  it('parses a complete spec', () => {
    const parsed = GameSpec.parse({
      schemaVersion: 1,
      genre: 'fps',
      dimensions: '3d',
      perspective: 'first_person',
      cameraKind: 'first_person',
      primaryInputs: ['keyboard', 'mouse', 'pointer_lock'],
      numActors: 8,
      winCondition: 'Clear all enemy waves and reach the exit door.',
      loseCondition: 'Player health reaches zero.',
      features: {
        vault: { trigger: 'manual', directional: true, animated: true },
        reload: { hud: 'holographic', duration_ms: 1500 },
      },
    });
    expect(parsed.genre).toBe('fps');
    expect(parsed.features['vault']?.['trigger']).toBe('manual');
  });

  it('rejects an invalid genre', () => {
    expect(() =>
      GameSpec.parse({
        schemaVersion: 1,
        genre: 'mmo',
        dimensions: '3d',
        perspective: 'first_person',
        cameraKind: 'first_person',
        primaryInputs: ['keyboard'],
        numActors: 1,
        winCondition: 'Survive.',
        loseCondition: 'Die.',
      }),
    ).toThrow();
  });

  it('requires at least one primary input', () => {
    expect(() =>
      GameSpec.parse({
        genre: 'puzzle',
        dimensions: '2d',
        perspective: 'fixed_screen',
        cameraKind: 'static',
        primaryInputs: [],
        numActors: 1,
        winCondition: 'Match all tiles.',
        loseCondition: '—',
      }),
    ).toThrow();
  });
});

describe('applyGameSpecPatch — feature carry-forward (FPS vault case)', () => {
  it('preserves untouched features when amending one feature', () => {
    const prior = GameSpec.parse({
      genre: 'fps',
      dimensions: '3d',
      perspective: 'first_person',
      cameraKind: 'first_person',
      primaryInputs: ['keyboard', 'mouse', 'pointer_lock'],
      numActors: 8,
      winCondition: 'Reach the exit.',
      loseCondition: 'Health hits zero.',
      features: {
        vault: { trigger: 'auto', directional: false, animated: false },
        melee: { weapon: 'knife', binding: 'v' },
      },
    });
    // Amend ONLY the vault feature with the user-corrected values.
    const after = applyGameSpecPatch(prior, {
      features: {
        vault: { trigger: 'manual', directional: true, animated: true },
      },
      reason: 'User asked for press-jump-to-vault, directional, smooth anim',
    });
    expect(after.features['vault']?.['trigger']).toBe('manual');
    expect(after.features['vault']?.['directional']).toBe(true);
    expect(after.features['vault']?.['animated']).toBe(true);
    // Melee feature must survive verbatim.
    expect(after.features['melee']?.['weapon']).toBe('knife');
    expect(after.features['melee']?.['binding']).toBe('v');
  });

  it('amend without features keeps all features intact', () => {
    const prior = GameSpec.parse({
      genre: 'platformer',
      dimensions: '2d',
      perspective: 'side_scroll',
      cameraKind: 'follow_horizontal',
      primaryInputs: ['keyboard'],
      numActors: 2,
      winCondition: 'Reach the flag.',
      loseCondition: 'Run out of lives.',
      features: { jump: { height: 5 }, dash: { distance: 3 } },
    });
    const after = applyGameSpecPatch(prior, { numActors: 4 });
    expect(after.numActors).toBe(4);
    expect(after.features['jump']?.['height']).toBe(5);
    expect(after.features['dash']?.['distance']).toBe(3);
  });

  it('deep-merges a partial capabilities amend (does NOT reset un-restated traits)', () => {
    const prior = GameSpec.parse({
      genre: 'topdown_arcade',
      capabilities: {
        mechanics: ['shoot'],
        controlScheme: 'twin_stick',
        hasEnemies: true,
        escalates: true,
      },
      dimensions: '2d',
      perspective: 'top_down',
      cameraKind: 'follow_2d',
      primaryInputs: ['keyboard', 'mouse'],
      numActors: 6,
      winCondition: 'Survive 10 waves.',
      loseCondition: 'Shield hits zero.',
      features: {},
    });
    // Amend ONLY hasProgression — every other capability must survive.
    const after = applyGameSpecPatch(prior, { capabilities: { hasProgression: true } });
    expect(after.capabilities?.hasProgression).toBe(true);
    expect(after.capabilities?.hasEnemies).toBe(true); // NOT reset to false
    expect(after.capabilities?.escalates).toBe(true); // NOT reset to false
    expect(after.capabilities?.controlScheme).toBe('twin_stick');
    expect(after.capabilities?.mechanics).toEqual(['shoot']);
  });
});

describe('checkEngineFit — gating matrix', () => {
  it('OKs 3D fighting on three and WARNs on phaser (the brawler case)', () => {
    const spec = GameSpec.parse({
      genre: 'fighting',
      dimensions: '3d',
      perspective: 'top_down',
      cameraKind: 'follow_3d',
      primaryInputs: ['keyboard'],
      numActors: 2,
      winCondition: 'Reduce opponent HP to zero.',
      loseCondition: 'Your HP hits zero.',
    });
    expect(checkEngineFit(spec, 'three').verdict).toBe('ok');
    expect(checkEngineFit(spec, 'phaser').verdict).toBe('warn');
  });

  it('WARNs FPS on phaser and OKs FPS on three (raycaster vs WebGL)', () => {
    const spec = GameSpec.parse({
      genre: 'fps',
      dimensions: '3d',
      perspective: 'first_person',
      cameraKind: 'first_person',
      primaryInputs: ['keyboard', 'mouse', 'pointer_lock'],
      numActors: 8,
      winCondition: 'Survive all waves.',
      loseCondition: 'HP hits zero.',
    });
    expect(checkEngineFit(spec, 'phaser').verdict).toBe('warn');
    expect(checkEngineFit(spec, 'three').verdict).toBe('ok');
  });

  it('OKs Phaser for 2D platformer', () => {
    const spec = GameSpec.parse({
      genre: 'platformer',
      dimensions: '2d',
      perspective: 'side_scroll',
      cameraKind: 'follow_horizontal',
      primaryInputs: ['keyboard'],
      numActors: 2,
      winCondition: 'Reach the flag.',
      loseCondition: 'Out of lives.',
    });
    expect(checkEngineFit(spec, 'phaser').verdict).toBe('ok');
  });

  it('WARNs when cameraKind=first_person but perspective is not', () => {
    const spec = GameSpec.parse({
      genre: 'tps',
      dimensions: '3d',
      perspective: 'third_person',
      cameraKind: 'first_person',
      primaryInputs: ['keyboard', 'mouse'],
      numActors: 1,
      winCondition: 'Beat the level.',
      loseCondition: 'HP zero.',
    });
    expect(checkEngineFit(spec, 'three').verdict).toBe('warn');
  });

  it('OKs 2D briefs on three (parallax) as well as phaser', () => {
    const spec = GameSpec.parse({
      genre: 'platformer',
      dimensions: '2d',
      perspective: 'side_scroll',
      cameraKind: 'follow_horizontal',
      primaryInputs: ['keyboard'],
      numActors: 2,
      winCondition: 'Reach the flag.',
      loseCondition: 'Out of lives.',
    });
    expect(checkEngineFit(spec, 'phaser').verdict).toBe('ok');
    expect(checkEngineFit(spec, 'three').verdict).toBe('ok');
  });
});

describe('validateCapabilities — capability reconciliation (P4)', () => {
  it('demotes escalates for a handcrafted-level genre (platformer)', () => {
    const { corrected, conflicts } = validateCapabilities({
      genre: 'platformer',
      capabilities: GameCapabilities.parse({ escalates: true, hasProgression: true }),
    });
    expect(corrected?.escalates).toBe(false);
    expect(conflicts.length).toBeGreaterThan(0);
  });

  it('demotes escalates for an ambient pointer/drag toy with no enemies (garden)', () => {
    const { corrected, conflicts } = validateCapabilities({
      genre: 'other',
      capabilities: GameCapabilities.parse({
        escalates: true,
        controlScheme: 'drag',
        hasEnemies: false,
      }),
    });
    expect(corrected?.escalates).toBe(false);
    expect(conflicts.length).toBeGreaterThan(0);
  });

  it('leaves a real wave-shooter escalates flag intact', () => {
    const { corrected, conflicts } = validateCapabilities({
      genre: 'shmup',
      capabilities: GameCapabilities.parse({ escalates: true, hasEnemies: true }),
    });
    expect(corrected?.escalates).toBe(true);
    expect(conflicts).toEqual([]);
  });

  it('no capabilities → no-op', () => {
    const { corrected, conflicts } = validateCapabilities({ genre: 'platformer' });
    expect(corrected).toBeUndefined();
    expect(conflicts).toEqual([]);
  });
});

describe('validateCapabilities — P10 networking guidance', () => {
  it('flags requiresNetworking with honest local-scoping guidance (no demotion)', () => {
    const { corrected, conflicts } = validateCapabilities({
      genre: 'shmup',
      capabilities: GameCapabilities.parse({ requiresNetworking: true, hasEnemies: true }),
    });
    expect(conflicts.some((c) => /local|decline|single-origin/i.test(c))).toBe(true);
    expect(corrected?.requiresNetworking).toBe(true); // guidance, not a demotion
  });
});
