/**
 * gameplan §7.1 — adapter registry tests.
 */

import { describe, expect, it } from 'vitest';
import { GAME_ENGINE_ADAPTERS, getEngineAdapter, listLivePreviewEngines } from './index';

describe('GAME_ENGINE_ADAPTERS registry', () => {
  it('registers exactly the two supported web engines (three + phaser)', () => {
    expect(GAME_ENGINE_ADAPTERS.has('three')).toBe(true);
    expect(GAME_ENGINE_ADAPTERS.has('phaser')).toBe(true);
    expect(GAME_ENGINE_ADAPTERS.size).toBe(2);
  });

  it('returns the adapter via getEngineAdapter for every registered id', () => {
    expect(getEngineAdapter('three')?.id).toBe('three');
    expect(getEngineAdapter('phaser')?.id).toBe('phaser');
  });

  it('listLivePreviewEngines covers three + phaser', () => {
    const live = listLivePreviewEngines();
    expect(live).toContain('three');
    expect(live).toContain('phaser');
    expect(live).toHaveLength(2);
  });
});
