import type { GameSpec } from '@playforge/shared';
import { Value } from '@sinclair/typebox/value';
/**
 * may9 Phase 4 — declare_game_spec + amend_game_spec round-trip.
 *
 * Verifies: tool calls the host's setSpec callback with the validated
 * GameSpec; amend_game_spec preserves untouched features (the FPS vault
 * carry-forward case); amend without a prior spec rejects.
 */
import { describe, expect, it } from 'vitest';
import { gardenProductionPlan } from '../../../shared/src/testing/production-fixtures';
import { makeAmendGameSpecTool } from './amend-game-spec';
import { makeChooseEngineTool } from './choose-engine';
import { makeDeclareGameSpecTool } from './declare-game-spec';
import { ProductionPlanParams } from './production-plan-schema';

describe('declare_game_spec', () => {
  it('requires a complete production plan on new cloud builds before engine selection', async () => {
    let spec: GameSpec | undefined;
    const declare = makeDeclareGameSpecTool((next) => {
      spec = next;
    }, true);
    const choose = makeChooseEngineTool(undefined, () => spec, true);
    const params = {
      genre: 'other' as const,
      dimensions: '2d' as const,
      perspective: 'fixed_screen' as const,
      cameraKind: 'static' as const,
      primaryInputs: ['mouse' as const],
      numActors: 0,
      winCondition: '—',
      loseCondition: '—',
    };
    await expect(
      choose.execute('early', { engine: 'phaser', rationale: 'Pointer composition' }),
    ).rejects.toThrow('productionPlan');
    await expect(declare.execute('no-plan', params)).rejects.toThrow('productionPlan');
    const productionPlan: unknown = gardenProductionPlan();
    if (!Value.Check(ProductionPlanParams, productionPlan)) throw new Error('Invalid tool fixture');
    await declare.execute('planned', { ...params, productionPlan });
    await expect(
      choose.execute('ready', { engine: 'phaser', rationale: 'Pointer composition' }),
    ).resolves.toMatchObject({ details: { engine: 'phaser' } });
    await expect(
      choose.execute('legacy', { engine: 'canvas2d', rationale: 'Legacy' }),
    ).rejects.toThrow('existing projects');
    expect(spec?.productionPlan?.requirements[0]?.id).toBe('connect');
  });
  it('persists a parsed GameSpec via setSpec', async () => {
    let captured: GameSpec | undefined;
    const tool = makeDeclareGameSpecTool((spec) => {
      captured = spec;
    });
    const res = await tool.execute('call-1', {
      genre: 'fps',
      dimensions: '3d',
      perspective: 'first_person',
      cameraKind: 'first_person',
      primaryInputs: ['keyboard', 'mouse', 'pointer_lock'],
      numActors: 8,
      winCondition: 'Reach the exit door.',
      loseCondition: 'Health hits zero.',
      features: { reload: { duration_ms: 1500 } },
    });
    expect(captured).toBeDefined();
    expect(captured?.genre).toBe('fps');
    expect(captured?.dimensions).toBe('3d');
    expect(captured?.features['reload']?.['duration_ms']).toBe(1500);
    expect(res.details.actors).toBe(8);
    expect(res.details.features).toBe(1);
  });

  it('still returns success even when host has no setter (vitest path)', async () => {
    const tool = makeDeclareGameSpecTool(undefined);
    const res = await tool.execute('call-2', {
      genre: 'platformer',
      dimensions: '2d',
      perspective: 'side_scroll',
      cameraKind: 'follow_horizontal',
      primaryInputs: ['keyboard'],
      numActors: 1,
      winCondition: 'Reach the flag.',
      loseCondition: 'Out of lives.',
    });
    expect(res.details.genre).toBe('platformer');
  });
});

describe('amend_game_spec — feature carry-forward (FPS vault)', () => {
  it('preserves untouched features when amending one feature', async () => {
    let current: GameSpec | undefined;
    const declare = makeDeclareGameSpecTool((spec) => {
      current = spec;
    });
    const amend = makeAmendGameSpecTool(
      () => current,
      (spec) => {
        current = spec;
      },
    );
    await declare.execute('call-1', {
      genre: 'fps',
      dimensions: '3d',
      perspective: 'first_person',
      cameraKind: 'first_person',
      primaryInputs: ['keyboard', 'mouse', 'pointer_lock'],
      numActors: 8,
      winCondition: 'Reach the exit door.',
      loseCondition: 'Health hits zero.',
      features: {
        vault: { trigger: 'auto', directional: false, animated: false },
        melee: { weapon: 'knife', binding: 'v' },
      },
    });
    const res = await amend.execute('call-2', {
      features: { vault: { trigger: 'manual', directional: true, animated: true } },
      reason: 'User asked for press-jump-to-vault, directional, smooth anim',
    });
    expect(res.details.changedKeys).toContain('features');
    expect(current?.features['vault']?.['trigger']).toBe('manual');
    expect(current?.features['vault']?.['directional']).toBe(true);
    // Melee survives verbatim.
    expect(current?.features['melee']?.['weapon']).toBe('knife');
    expect(current?.features['melee']?.['binding']).toBe('v');
  });

  it('rejects amend when no prior spec exists', async () => {
    const amend = makeAmendGameSpecTool(
      () => undefined,
      () => {},
    );
    const res = await amend.execute('call-1', { numActors: 2 });
    expect(res.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('No prior spec'),
    });
  });

  it('rejects amend when getSpec is undefined (host opted out)', async () => {
    const amend = makeAmendGameSpecTool(undefined, undefined);
    const res = await amend.execute('call-1', { numActors: 2 });
    expect(res.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('unavailable'),
    });
  });
});
