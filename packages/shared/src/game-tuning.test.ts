import { describe, expect, it } from 'vitest';
import { injectControlsRuntime } from './controls-runtime';
import { replaceTweakSchema } from './editmode';
import {
  GAME_TUNING_BRIDGE_MARKER,
  hasGameTuning,
  inferTweakSchema,
  parseGameTuning,
} from './game-tuning';

/** What a game that declares its feel numbers properly looks like — the shape
 *  the five scattered `setVelocityY(-360)` / `(-420)` / `(-340)` literals in the
 *  production parkour runner should have had. */
const GAME_SOURCE = `
const TUNING = /*GAME-TUNING-BEGIN*/{
  "jumpVelocity": 360,
  "doubleJumpVelocity": 420,
  "gravity": 1800,
  "playerTint": "#ff4400",
  "doubleJumpEnabled": true
}/*GAME-TUNING-END*/;
window.__game = window.__game || {};
window.__game.tuning = TUNING;
`;

describe('parseGameTuning', () => {
  it('reads the declared block', () => {
    expect(parseGameTuning(GAME_SOURCE)).toEqual({
      jumpVelocity: 360,
      doubleJumpVelocity: 420,
      gravity: 1800,
      playerTint: '#ff4400',
      doubleJumpEnabled: true,
    });
    expect(hasGameTuning(GAME_SOURCE)).toBe(true);
  });

  it('treats a malformed block as absent rather than throwing', () => {
    // This runs at persist time over agent-authored source; a bad block must
    // degrade to "no sliders", never sink the run.
    const bad = 'const T = /*GAME-TUNING-BEGIN*/{ not json }/*GAME-TUNING-END*/;';
    expect(parseGameTuning(bad)).toBeNull();
    expect(() => parseGameTuning(bad)).not.toThrow();
  });

  it('returns null for a file with no block', () => {
    expect(parseGameTuning('const x = 1;')).toBeNull();
    expect(hasGameTuning('const x = 1;')).toBe(false);
  });

  it('drops non-primitive and non-finite values', () => {
    const src =
      'const T = /*GAME-TUNING-BEGIN*/{"a":1,"b":{"nested":true},"c":[1,2],"d":null}/*GAME-TUNING-END*/;';
    expect(parseGameTuning(src)).toEqual({ a: 1 });
  });
});

describe('inferTweakSchema', () => {
  it('brackets a positive number from 0 to 2x so the slider is usable', () => {
    const s = inferTweakSchema({ jumpVelocity: 360 })['jumpVelocity'];
    expect(s).toMatchObject({ kind: 'number', min: 0, max: 720 });
  });

  it('brackets a negative number symmetrically (engines whose up is -y)', () => {
    const s = inferTweakSchema({ jumpVelocity: -360 })['jumpVelocity'];
    expect(s).toMatchObject({ kind: 'number', min: -720, max: 720 });
  });

  it('gives a hex string a colour swatch, not a text field', () => {
    expect(inferTweakSchema({ tint: '#ff4400' })['tint']).toEqual({ kind: 'color' });
    expect(inferTweakSchema({ label: 'Level 1' })['label']).toEqual({ kind: 'string' });
  });

  it('maps booleans to a toggle', () => {
    expect(inferTweakSchema({ doubleJump: true })['doubleJump']).toEqual({ kind: 'boolean' });
  });

  it('never produces a zero-width band for a zero default', () => {
    const s = inferTweakSchema({ offset: 0 })['offset'] as { min: number; max: number };
    expect(s.max).toBeGreaterThan(s.min);
  });
});

describe('replaceTweakSchema on a GAME', () => {
  it('anchors on GAME_TUNING when there is no TWEAK_DEFAULTS', () => {
    // The regression: games have no TWEAK_DEFAULTS (a design-artifact
    // construct), so `declare_tweak_schema` returned the source unchanged on
    // every game and the tweak panel never got a schema.
    const out = replaceTweakSchema(GAME_SOURCE, { jumpVelocity: { kind: 'number', max: 800 } });
    expect(out).not.toBe(GAME_SOURCE);
    expect(out).toContain('TWEAK-SCHEMA-BEGIN');
    // Inserted AFTER the tuning statement, so the tuning block still parses.
    expect(parseGameTuning(out)).not.toBeNull();
  });
});

describe('tuning bridge injection', () => {
  it('is injected into served game HTML alongside the other runtimes', () => {
    const html = injectControlsRuntime('<html><head></head><body></body></html>');
    expect(html).toContain(GAME_TUNING_BRIDGE_MARKER);
  });

  it('is idempotent across a double pass', () => {
    const once = injectControlsRuntime('<html><head></head><body></body></html>');
    const twice = injectControlsRuntime(once);
    const count = twice.split(GAME_TUNING_BRIDGE_MARKER).length - 1;
    expect(count).toBe(1);
  });

  it('does not depend on React/ReactDOM (the bridge it replaces did)', () => {
    const html = injectControlsRuntime('<html><head></head><body></body></html>');
    const start = html.indexOf(GAME_TUNING_BRIDGE_MARKER);
    const snippet = html.slice(start, html.indexOf('</script>', start));
    expect(snippet).not.toMatch(/ReactDOM|Babel/);
    // And it must not be an eval primitive — that was the other half of why the
    // old bridge was unsafe to point at a game.
    expect(snippet).not.toMatch(/new Function|\beval\b/);
  });
});
