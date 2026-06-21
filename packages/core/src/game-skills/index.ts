/**
 * Game-skill + JUICE/FEEL starter snippets — engine-correct primitives that
 * the agent can `list` and `view` from the virtual filesystem and adapt to
 * the user's brief. This is the anti-slop differentiator: without these, the
 * agent re-derives game feel from scratch every run and ships flat games.
 *
 * Two buckets, both surfaced through the same registry:
 *   1. The pre-existing "engine scaffolding" skills (audio cue, controller,
 *      scene system, game loop, …) that shipped DEAD (zero references).
 *   2. The authored JUICE/FEEL primitives — screen-shake, hitstop, particle
 *      burst, squash & stretch, score-pop / floating text, screen-flash,
 *      camera-kick, knockback — one per engine (Phaser 3 + Three.js).
 *
 * Each file is a self-contained ES module with a leading `// when_to_use:`
 * hint comment so the agent can pick the
 * matching snippet before writing code. The `engine` + `category` fields let
 * `list_game_feel` filter to the relevant engine and surface the feel set.
 *
 * Loaded via `readFileSync(new URL(...))` — Vite's `?raw` suffix is
 * unavailable outside the bundler (the cloud agent runs under plain Node/tsx).
 * The
 * package is consumed straight from `./src`, so the sibling `.js`/`.jsx`
 * payloads resolve relative to this module at runtime.
 */

import { readFileSync } from 'node:fs';

const raw = (file: string): string => readFileSync(new URL(file, import.meta.url), 'utf8');

export type GameEngine = 'phaser' | 'three';
/** `feel` = juice/impact-feedback primitive; `engine` = scaffolding helper. */
export type GameSkillCategory = 'feel' | 'engine';

export interface GameSkillEntry {
  /** Unique catalogue id, e.g. `phaser/screen-shake.js`. */
  readonly name: string;
  readonly engine: GameEngine;
  readonly category: GameSkillCategory;
  readonly source: string;
}

interface GameSkillSpec {
  readonly name: string;
  readonly engine: GameEngine;
  readonly category: GameSkillCategory;
}

// ── Phaser ────────────────────────────────────────────────────────────────
const PHASER_SKILLS: ReadonlyArray<GameSkillSpec> = [
  // Authored juice / feel primitives (the anti-slop set).
  { name: 'phaser/screen-shake.js', engine: 'phaser', category: 'feel' },
  { name: 'phaser/hitstop.js', engine: 'phaser', category: 'feel' },
  { name: 'phaser/particle-burst.js', engine: 'phaser', category: 'feel' },
  { name: 'phaser/squash-stretch.js', engine: 'phaser', category: 'feel' },
  { name: 'phaser/score-pop.js', engine: 'phaser', category: 'feel' },
  { name: 'phaser/screen-flash.js', engine: 'phaser', category: 'feel' },
  { name: 'phaser/knockback.js', engine: 'phaser', category: 'feel' },
  // Pre-existing engine scaffolding (previously dead).
  { name: 'phaser/arcade-physics.js', engine: 'phaser', category: 'engine' },
  { name: 'phaser/audio-cue.js', engine: 'phaser', category: 'engine' },
  { name: 'phaser/controller.js', engine: 'phaser', category: 'engine' },
  { name: 'phaser/scene-system.js', engine: 'phaser', category: 'engine' },
  { name: 'phaser/sprite-batching.js', engine: 'phaser', category: 'engine' },
  { name: 'phaser/tilemap-loader.js', engine: 'phaser', category: 'engine' },
  // Combat & difficulty (enemies + escalating waves — the anti-flat-game set).
  { name: 'phaser/enemy-ai.js', engine: 'phaser', category: 'engine' },
  { name: 'phaser/wave-spawner.js', engine: 'phaser', category: 'engine' },
  // Capability systems (Engine Evolution P8) — composable building blocks the
  // capability recommender (recommend-skills.ts) pushes per game's declared traits.
  { name: 'phaser/level-orchestrator.js', engine: 'phaser', category: 'engine' },
  { name: 'phaser/procedural-gen.js', engine: 'phaser', category: 'engine' },
  { name: 'phaser/animation-sequencer.js', engine: 'phaser', category: 'engine' },
  { name: 'phaser/save-state.js', engine: 'phaser', category: 'engine' },
  { name: 'phaser/dialog-flow.js', engine: 'phaser', category: 'engine' },
  { name: 'phaser/mobile-controls.js', engine: 'phaser', category: 'engine' },
  { name: 'phaser/economy-system.js', engine: 'phaser', category: 'engine' },
  { name: 'phaser/rhythm-clock.js', engine: 'phaser', category: 'engine' },
];

// ── Three.js ────────────────────────────────────────────────────────────────
const THREE_SKILLS: ReadonlyArray<GameSkillSpec> = [
  // Authored juice / feel primitives (the anti-slop set).
  { name: 'three/screen-shake.jsx', engine: 'three', category: 'feel' },
  { name: 'three/hitstop.jsx', engine: 'three', category: 'feel' },
  { name: 'three/particle-burst.jsx', engine: 'three', category: 'feel' },
  { name: 'three/squash-stretch.jsx', engine: 'three', category: 'feel' },
  { name: 'three/score-pop.jsx', engine: 'three', category: 'feel' },
  { name: 'three/screen-flash.jsx', engine: 'three', category: 'feel' },
  { name: 'three/knockback.jsx', engine: 'three', category: 'feel' },
  // Pre-existing engine scaffolding (previously dead).
  { name: 'three/audio-cue.jsx', engine: 'three', category: 'engine' },
  { name: 'three/camera-controller.jsx', engine: 'three', category: 'engine' },
  { name: 'three/controller.jsx', engine: 'three', category: 'engine' },
  { name: 'three/game-loop.jsx', engine: 'three', category: 'engine' },
  { name: 'three/input-handler.jsx', engine: 'three', category: 'engine' },
  { name: 'three/scene-transition.jsx', engine: 'three', category: 'engine' },
  { name: 'three/sprite-system.jsx', engine: 'three', category: 'engine' },
  // Combat & difficulty (enemies + escalating waves — the anti-flat-game set).
  { name: 'three/enemy-ai.jsx', engine: 'three', category: 'engine' },
  { name: 'three/wave-spawner.jsx', engine: 'three', category: 'engine' },
  // Capability systems (Engine Evolution P8) — composable building blocks the
  // capability recommender (recommend-skills.ts) pushes per game's declared traits.
  { name: 'three/level-orchestrator.jsx', engine: 'three', category: 'engine' },
  { name: 'three/procedural-gen.jsx', engine: 'three', category: 'engine' },
  { name: 'three/animation-sequencer.jsx', engine: 'three', category: 'engine' },
  { name: 'three/save-state.jsx', engine: 'three', category: 'engine' },
  { name: 'three/dialog-flow.jsx', engine: 'three', category: 'engine' },
  { name: 'three/mobile-controls.jsx', engine: 'three', category: 'engine' },
  { name: 'three/economy-system.jsx', engine: 'three', category: 'engine' },
  { name: 'three/rhythm-clock.jsx', engine: 'three', category: 'engine' },
];

const ALL_SPECS: ReadonlyArray<GameSkillSpec> = [...PHASER_SKILLS, ...THREE_SKILLS];

/** Every game-skill snippet — feel primitives first per engine, then the
 *  pre-existing scaffolding — loaded with its source. Frozen at module load. */
export const GAME_SKILLS: ReadonlyArray<GameSkillEntry> = Object.freeze(
  ALL_SPECS.map((spec) =>
    Object.freeze({
      name: spec.name,
      engine: spec.engine,
      category: spec.category,
      source: raw(`./${spec.name}`),
    }),
  ),
);
