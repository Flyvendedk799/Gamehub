/**
 * Phase 3.5 — homepage example chips wired to the real bundled briefs.
 *
 * The homepage used to show four hand-written placeholder strings. We now drive
 * the chips off `GAME_EXAMPLE_BRIEFS` from `@playforge/templates` so picking a
 * chip is a ONE-CLICK build: it submits the brief's `brief` text through the
 * exact same auth-aware / pending-prompt path as typing a prompt.
 *
 * The brief's `engine` field is `'three' | 'phaser'`; the createProject API
 * speaks the web `Engine` union (`'phaser' | 'threejs' | 'vanilla'`), so we map
 * `'three' → 'threejs'` here. This mapping is pure + unit-tested.
 */

import { GAME_EXAMPLE_BRIEFS } from '@playforge/templates';
import type { GameExampleBrief } from '@playforge/templates';
import type { Engine } from './types';

export type { GameExampleBrief };

export { GAME_EXAMPLE_BRIEFS };

/**
 * Map a bundled brief's engine to the engine value `createProject` expects.
 * `'three'` is the templates spelling; the web API wants `'threejs'`.
 */
export function briefEngineToApiEngine(engine: GameExampleBrief['engine']): Engine {
  return engine === 'three' ? 'threejs' : 'phaser';
}

/**
 * The prompt text a chip submits. Today this is just the brief body, but
 * centralising it keeps the chip-pick handler honest and gives us one place to
 * unit-test the brief → prompt mapping.
 */
export function briefToPrompt(brief: GameExampleBrief): string {
  return brief.brief;
}
