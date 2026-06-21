/**
 * gameplan §7.1 — adapter registry tests.
 */

import { describe, expect, it } from 'vitest';
import { GAME_ENGINE_ADAPTERS, getEngineAdapter, listLivePreviewEngines } from './index';
import { SCORE_MESSAGE_TYPE, gameGlobalSetupSnippet, isScoreMessage } from './types';

describe('GAME_ENGINE_ADAPTERS registry', () => {
  it('registers the supported web engines (three + phaser + canvas2d)', () => {
    expect(GAME_ENGINE_ADAPTERS.has('three')).toBe(true);
    expect(GAME_ENGINE_ADAPTERS.has('phaser')).toBe(true);
    expect(GAME_ENGINE_ADAPTERS.has('canvas2d')).toBe(true);
    expect(GAME_ENGINE_ADAPTERS.size).toBe(3);
  });

  it('returns the adapter via getEngineAdapter for every registered id', () => {
    expect(getEngineAdapter('three')?.id).toBe('three');
    expect(getEngineAdapter('phaser')?.id).toBe('phaser');
    expect(getEngineAdapter('canvas2d')?.id).toBe('canvas2d');
  });

  it('listLivePreviewEngines covers three + phaser + canvas2d', () => {
    const live = listLivePreviewEngines();
    expect(live).toContain('three');
    expect(live).toContain('phaser');
    expect(live).toContain('canvas2d');
    expect(live).toHaveLength(3);
  });
});

describe('leaderboard score bridge (Phase 3.8)', () => {
  it('gameGlobalSetupSnippet wires window.__game.reportScore that posts the score frame', () => {
    const snippet = gameGlobalSetupSnippet({
      engine: 'phaser',
      initialParams: {},
      startMuted: false,
    });
    // The shim defines reportScore and posts a same-window frame to the parent.
    expect(snippet).toContain('window.__game.reportScore');
    expect(snippet).toContain('window.parent.postMessage');
    expect(snippet).toContain(JSON.stringify(SCORE_MESSAGE_TYPE));
  });

  it('isScoreMessage accepts a well-formed frame and rejects malformed ones', () => {
    expect(isScoreMessage({ type: SCORE_MESSAGE_TYPE, score: 42 })).toBe(true);
    expect(isScoreMessage({ type: SCORE_MESSAGE_TYPE, score: 0 })).toBe(true);
    // Wrong type, non-numeric/non-finite score, and non-objects are rejected.
    expect(isScoreMessage({ type: 'game:setParams', score: 42 })).toBe(false);
    expect(isScoreMessage({ type: SCORE_MESSAGE_TYPE, score: 'high' })).toBe(false);
    expect(isScoreMessage({ type: SCORE_MESSAGE_TYPE, score: Number.NaN })).toBe(false);
    expect(isScoreMessage({ type: SCORE_MESSAGE_TYPE })).toBe(false);
    expect(isScoreMessage(null)).toBe(false);
    expect(isScoreMessage('nope')).toBe(false);
  });
});
