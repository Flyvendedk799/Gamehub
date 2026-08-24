import type { Engine } from './types';

/**
 * The web's engine spelling → the id the API actually accepts.
 *
 * These two vocabularies drifted. The web says `'threejs'` and `'vanilla'`; the
 * API's allow-list is `['three', 'phaser', 'canvas2d']` and it answers anything
 * else with `400 invalid_engine`. So picking "THREE.JS 3D" on the landing page
 * failed at project creation, every time, while "PHASER 2D" worked — because
 * `'phaser'` happens to be spelled the same on both sides.
 *
 * `engineLabel` already accepted both spellings, which is the tell: the display
 * layer was taught to cope instead of the wire being fixed. This is the wire.
 *
 * `'auto'` is not an engine. It maps to `undefined`, which the API treats as
 * "not specified" — the request omits the field and the agent's `choose_engine`
 * decides, which is what you want when the person describing the game does not
 * know or care whether it should be 2D or 3D.
 */
export type ApiEngine = 'three' | 'phaser' | 'canvas2d';

/** What the picker can offer: a concrete engine, or letting the agent decide. */
export type EngineChoice = Engine | 'auto';

export function toApiEngine(choice: EngineChoice): ApiEngine | undefined {
  switch (choice) {
    case 'phaser':
      return 'phaser';
    case 'threejs':
      return 'three';
    case 'vanilla':
      return 'canvas2d';
    default:
      // 'auto' — omit the field entirely so the agent chooses.
      return undefined;
  }
}

/** The API's spelling → the web's, for reading a project back. */
export function fromApiEngine(engine: string | null | undefined): Engine | null {
  switch (engine) {
    case 'phaser':
      return 'phaser';
    case 'three':
    case 'threejs':
      return 'threejs';
    case 'canvas2d':
    case 'vanilla':
      return 'vanilla';
    default:
      return null;
  }
}
