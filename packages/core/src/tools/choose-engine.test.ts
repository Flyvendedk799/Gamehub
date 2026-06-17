/**
 * gameplan §A5 + may9 Phase 4 — choose_engine tool tests.
 */

import { GameSpec } from '@playforge/shared';
import { describe, expect, it, vi } from 'vitest';
import { type ChooseEngineEngine, makeChooseEngineTool } from './choose-engine';

describe('makeChooseEngineTool', () => {
  it('forwards engine + rationale to the host setEngine callback', async () => {
    const setEngine = vi.fn();
    const tool = makeChooseEngineTool(setEngine);
    const result = await tool.execute('id-1', {
      engine: 'phaser',
      rationale: 'Brief is a 2D platformer — Phaser is the natural fit.',
    });
    expect(setEngine).toHaveBeenCalledWith(
      'phaser',
      'Brief is a 2D platformer — Phaser is the natural fit.',
    );
    expect(result.details.engine).toBe('phaser');
    expect(result.details.rationale).toContain('Phaser');
  });

  it('accepts both engine ids', async () => {
    const setEngine = vi.fn();
    const tool = makeChooseEngineTool(setEngine);
    for (const engine of ['three', 'phaser'] satisfies ChooseEngineEngine[]) {
      await tool.execute(`id-${engine}`, { engine, rationale: 'because' });
    }
    expect(setEngine).toHaveBeenCalledTimes(2);
  });

  it('runs as a no-op when the host did not wire setEngine', async () => {
    const tool = makeChooseEngineTool(undefined);
    const result = await tool.execute('id-1', { engine: 'three', rationale: 'r' });
    expect(result.details.engine).toBe('three');
  });

  it('returns a human-readable confirmation message', async () => {
    const tool = makeChooseEngineTool(vi.fn());
    const result = await tool.execute('id-1', { engine: 'phaser', rationale: '2D platformer' });
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).toContain('phaser');
    expect(text).toContain('2D platformer');
  });

  it('trims the rationale before persisting', async () => {
    const setEngine = vi.fn();
    const tool = makeChooseEngineTool(setEngine);
    await tool.execute('id-1', { engine: 'three', rationale: '   trimmed   ' });
    expect(setEngine).toHaveBeenCalledWith('three', 'trimmed');
  });
});

describe('makeChooseEngineTool — Phase 4 fit gate', () => {
  const fpsSpec = GameSpec.parse({
    genre: 'fps',
    dimensions: '3d',
    perspective: 'first_person',
    cameraKind: 'first_person',
    primaryInputs: ['keyboard', 'mouse', 'pointer_lock'],
    numActors: 8,
    winCondition: 'Reach the exit door.',
    loseCondition: 'Health hits zero.',
  });
  const platformerSpec = GameSpec.parse({
    genre: 'platformer',
    dimensions: '2d',
    perspective: 'side_scroll',
    cameraKind: 'follow_horizontal',
    primaryInputs: ['keyboard'],
    numActors: 1,
    winCondition: 'Reach the flag.',
    loseCondition: 'Out of lives.',
  });

  it('WARNs on 3D + phaser but still pins the engine', async () => {
    const setEngine = vi.fn();
    const tool = makeChooseEngineTool(setEngine, () => fpsSpec);
    const result = await tool.execute('id-1', { engine: 'phaser', rationale: 'r' });
    expect(setEngine).toHaveBeenCalledWith('phaser', 'r');
    expect(result.details.fitVerdict).toBe('warn');
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).toContain('WARNING');
  });

  it('WARNs on FPS + phaser but still pins the engine', async () => {
    const setEngine = vi.fn();
    const tool = makeChooseEngineTool(setEngine, () => fpsSpec);
    const result = await tool.execute('id-1', { engine: 'phaser', rationale: 'r' });
    expect(setEngine).toHaveBeenCalledWith('phaser', 'r');
    expect(result.details.fitVerdict).toBe('warn');
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).toContain('WARNING');
  });

  it('OKs FPS + three (the natural choice)', async () => {
    const setEngine = vi.fn();
    const tool = makeChooseEngineTool(setEngine, () => fpsSpec);
    const result = await tool.execute('id-1', { engine: 'three', rationale: 'r' });
    expect(setEngine).toHaveBeenCalledWith('three', 'r');
    expect(result.details.fitVerdict).toBe('ok');
  });

  it('OKs platformer + phaser', async () => {
    const setEngine = vi.fn();
    const tool = makeChooseEngineTool(setEngine, () => platformerSpec);
    const result = await tool.execute('id-1', { engine: 'phaser', rationale: 'r' });
    expect(result.details.fitVerdict).toBe('ok');
    expect(setEngine).toHaveBeenCalled();
  });

  it('skips the gate when getSpec returns undefined (no spec yet)', async () => {
    const setEngine = vi.fn();
    const tool = makeChooseEngineTool(setEngine, () => undefined);
    const result = await tool.execute('id-1', { engine: 'phaser', rationale: 'r' });
    expect(setEngine).toHaveBeenCalled();
    expect(result.details.fitVerdict).toBe('ok');
  });
});
