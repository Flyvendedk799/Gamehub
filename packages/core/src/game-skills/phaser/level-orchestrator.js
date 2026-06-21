// when_to_use: Phaser multi-level progression controller — reach for this any
// time the game has stages, worlds, floors, or discrete content unlocks. It
// holds an ordered list of level configs, fires transition callbacks between
// them (fade out → load next → fade in), supports restart-from-current, and
// exposes getState()={level,totalLevels,cleared} so the HUD and debug snapshot
// can always show which stage the player is on. Pair with wave-spawner.js per
// level for escalating enemy content. Capability tag: hasProgression.

import * as Phaser from 'phaser';

/**
 * Multi-level stage controller.
 *
 * config:
 *   levels[]             ordered array of level descriptors (any shape you need)
 *   onLevelStart(idx, descriptor, scene)   called after transition-in
 *   onLevelComplete(idx, descriptor, scene) called when you call .complete()
 *   onAllCleared(scene)  called after the final level completes
 *   transitionMs         fade duration for in/out (default 500)
 *   autoAdvance          if false, caller drives .advance() manually (default true)
 */
export function createLevelOrchestrator(scene, config = {}) {
  const levels = config.levels ?? [];
  const transitionMs = config.transitionMs ?? 500;
  const autoAdvance = config.autoAdvance !== false;

  const state = {
    level: 0, // 0-based current index
    totalLevels: levels.length,
    cleared: [], // indices that have been completed
    transitioning: false,
  };

  /** Fade camera to black, run work(), then fade back in. */
  function _transition(work) {
    if (state.transitioning) return;
    state.transitioning = true;
    scene.cameras.main.fadeOut(transitionMs, 0, 0, 0);
    scene.cameras.main.once('camerafadeoutcomplete', () => {
      work();
      scene.cameras.main.fadeIn(transitionMs, 0, 0, 0);
      scene.cameras.main.once('camerafadeincomplete', () => {
        state.transitioning = false;
        config.onLevelStart?.(state.level, levels[state.level], scene);
      });
    });
  }

  /** Start the first level (call once from create()). */
  function start() {
    state.level = 0;
    state.cleared = [];
    scene.cameras.main.fadeIn(transitionMs, 0, 0, 0);
    scene.cameras.main.once('camerafadeincomplete', () => {
      config.onLevelStart?.(state.level, levels[state.level], scene);
    });
  }

  /** Mark the current level complete; if autoAdvance, move to the next level
   *  after a transition, otherwise wait for the caller to call advance(). */
  function complete() {
    const idx = state.level;
    if (!state.cleared.includes(idx)) state.cleared.push(idx);
    config.onLevelComplete?.(idx, levels[idx], scene);

    if (idx >= levels.length - 1) {
      config.onAllCleared?.(scene);
      return;
    }
    if (autoAdvance) advance();
  }

  /** Advance to the next level (or a specific index). */
  function advance(toIndex) {
    const next = toIndex !== undefined ? toIndex : state.level + 1;
    if (next >= levels.length) return;
    _transition(() => {
      state.level = next;
    });
  }

  /** Restart the current level from scratch. */
  function restart() {
    const cur = state.level;
    _transition(() => {
      state.level = cur;
    });
  }

  /** Jump to a specific level index (for debug / checkpoint loading). */
  function jumpTo(idx) {
    if (idx < 0 || idx >= levels.length) return;
    advance(idx);
  }

  return {
    start,
    complete,
    advance,
    restart,
    jumpTo,
    /** Descriptor of the current level. */
    current() {
      return levels[state.level];
    },
    /** Snapshot for HUD + window.__game.debug.snapshot(). */
    getState() {
      return {
        level: state.level,
        totalLevels: state.totalLevels,
        cleared: state.cleared.slice(),
        transitioning: state.transitioning,
      };
    },
  };
}

// Usage:
//   import { createLevelOrchestrator } from './engine/level-orchestrator.js';
//   // create():
//   this.orchestrator = createLevelOrchestrator(this, {
//     levels: [
//       { name: 'Forest',  enemyType: 'goblin',  goal: 10 },
//       { name: 'Castle',  enemyType: 'knight',  goal: 15 },
//       { name: 'Volcano', enemyType: 'dragon',  goal: 5  },
//     ],
//     onLevelStart: (idx, desc) => {
//       this.hud.setLevel(idx + 1, desc.name);
//       this.spawnEnemies(desc.enemyType, desc.goal);
//     },
//     onLevelComplete: (idx) => this.hud.flash(`Level ${idx + 1} cleared!`),
//     onAllCleared: () => this.scene.start('VictoryScene'),
//   });
//   this.orchestrator.start();
//   // When all enemies are dead:
//   // this.orchestrator.complete();
//   // Restart current level on death:
//   // this.orchestrator.restart();
//
//   // Surface level state so playtests can verify progression:
//   //   window.__game.debug.snapshot = () => this.orchestrator.getState();
//   //   // -> { level: 1, totalLevels: 3, cleared: [0], transitioning: false }
