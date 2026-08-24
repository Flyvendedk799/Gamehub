/**
 * The web ↔ API engine vocabulary.
 *
 * These two spellings drifted and nothing checked them against each other, so
 * "THREE.JS 3D" sent `'threejs'` to an API whose allow-list is
 * `['three', 'phaser', 'canvas2d']` and got `400 invalid_engine` — every time,
 * for as long as the chip existed. `'phaser'` worked only because it happens to
 * be spelled identically on both sides.
 *
 * The allow-list is asserted literally here. If the API's list changes, this
 * fails, which is the point: the mapping cannot be correct in isolation.
 */

import { describe, expect, it } from 'vitest';
import { type EngineChoice, fromApiEngine, toApiEngine } from '../engine-api';
import { engineLabel } from '../engine-label';
import type { Engine } from '../types';

/** Copied from `services/api/src/server.ts`, deliberately by value. */
const API_ALLOWED = ['three', 'phaser', 'canvas2d'] as const;

const WEB_ENGINES: Engine[] = ['phaser', 'threejs', 'vanilla'];

describe('toApiEngine', () => {
  it('maps every web engine to an id the API accepts', () => {
    for (const engine of WEB_ENGINES) {
      const mapped = toApiEngine(engine);
      expect(mapped, `${engine} must map to something`).toBeDefined();
      expect(API_ALLOWED, `${engine} -> ${mapped}`).toContain(mapped);
    }
  });

  it('maps threejs to three, which is the bug this exists to prevent', () => {
    expect(toApiEngine('threejs')).toBe('three');
  });

  it('maps vanilla to canvas2d', () => {
    expect(toApiEngine('vanilla')).toBe('canvas2d');
  });

  it('leaves phaser alone', () => {
    expect(toApiEngine('phaser')).toBe('phaser');
  });

  it('maps auto to undefined so the field is omitted', () => {
    // Not a sentinel string: the API validates `engine` when present, so 'auto'
    // would be rejected. Omitting it is what lets choose_engine decide.
    expect(toApiEngine('auto')).toBeUndefined();
  });

  it('never returns a value the API would reject', () => {
    const choices: EngineChoice[] = [...WEB_ENGINES, 'auto'];
    for (const choice of choices) {
      const mapped = toApiEngine(choice);
      if (mapped === undefined) continue;
      expect(API_ALLOWED).toContain(mapped);
    }
  });
});

describe('fromApiEngine', () => {
  it('round-trips every web engine', () => {
    for (const engine of WEB_ENGINES) {
      const api = toApiEngine(engine);
      expect(fromApiEngine(api)).toBe(engine);
    }
  });

  it('accepts both spellings, because stored projects carry the old one', () => {
    // Projects created before the mapping existed have whatever the web sent.
    expect(fromApiEngine('three')).toBe('threejs');
    expect(fromApiEngine('threejs')).toBe('threejs');
    expect(fromApiEngine('canvas2d')).toBe('vanilla');
    expect(fromApiEngine('vanilla')).toBe('vanilla');
  });

  it('returns null for anything it does not recognise', () => {
    expect(fromApiEngine(null)).toBeNull();
    expect(fromApiEngine(undefined)).toBeNull();
    expect(fromApiEngine('unreal')).toBeNull();
  });
});

describe('labels', () => {
  it('has a label for every choice the picker offers', () => {
    for (const choice of [...WEB_ENGINES] as Engine[]) {
      expect(engineLabel(choice)).not.toBe('UNKNOWN');
    }
    // And for whatever comes back from the API, since a project card renders
    // the stored value directly.
    for (const id of API_ALLOWED) {
      expect(engineLabel(id)).not.toBe('UNKNOWN');
    }
  });
});
