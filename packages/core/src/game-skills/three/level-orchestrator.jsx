// when_to_use: Ordered level/stage progression controller — engine-agnostic,
// driven by an explicit update(dt) you call from the render loop. Reach for
// this when a game has discrete levels (not endless) that the player advances
// through by meeting a win condition. It owns the active-level index, win/lose
// detection hooks, transition timing (fade/hold before loading the next level),
// restart-from-any-level, and a cleared-set so skips are safe. Pairs with
// wave-spawner.jsx (onAllCleared → level.advance()) or custom win predicates.
// getState() returns { level, totalLevels, cleared } for HUD + save wiring.

/** Build a level orchestration controller.
 *
 *  config:
 *    levels           -> array of level definitions passed to onLoad
 *    onLoad(def, idx) -> called when a level becomes active; start its content
 *    onUnload(idx)    -> called before advancing to clean up prior content
 *    onWin(idx)       -> called when winCondition returns true
 *    onLose(idx)      -> called when loseCondition returns true
 *    onComplete()     -> all levels cleared
 *    winCondition()   -> () => bool; polled every update while 'playing'
 *    loseCondition()  -> () => bool; polled every update while 'playing'
 *    transitionSec    -> hold time between levels (default 1.5)
 *    startAt          -> level index to begin on (default 0)
 */
export function createLevelOrchestrator(config = {}) {
  const {
    levels = [],
    onLoad,
    onUnload,
    onWin,
    onLose,
    onComplete,
    winCondition,
    loseCondition,
    transitionSec = 1.5,
    startAt = 0,
  } = config;

  const totalLevels = levels.length;
  const cleared = new Set();

  let index = startAt;
  // 'idle' | 'playing' | 'win-transition' | 'lose-transition' | 'complete'
  let phase = 'idle';
  let transitionT = 0;

  function load(idx) {
    index = Math.max(0, Math.min(idx, totalLevels - 1));
    phase = 'playing';
    transitionT = 0;
    onLoad?.(levels[index], index);
  }

  function beginTransition(outcome) {
    phase = outcome === 'win' ? 'win-transition' : 'lose-transition';
    transitionT = 0;
    if (outcome === 'win') {
      cleared.add(index);
      onWin?.(index);
    } else {
      onLose?.(index);
    }
  }

  /** Advance timers + phase state machine. Call once per frame with delta seconds. */
  function update(dt) {
    switch (phase) {
      case 'idle':
        load(index);
        break;

      case 'playing': {
        const won = winCondition?.() ?? false;
        const lost = loseCondition?.() ?? false;
        if (won) {
          beginTransition('win');
        } else if (lost) {
          beginTransition('lose');
        }
        break;
      }

      case 'win-transition': {
        transitionT += dt;
        if (transitionT >= transitionSec) {
          onUnload?.(index);
          const next = index + 1;
          if (next >= totalLevels) {
            phase = 'complete';
            onComplete?.();
          } else {
            load(next);
          }
        }
        break;
      }

      case 'lose-transition': {
        transitionT += dt;
        if (transitionT >= transitionSec) {
          // Replay the current level.
          onUnload?.(index);
          load(index);
        }
        break;
      }

      default:
        break;
    }
  }

  /** Jump to any level by index. Unloads the current one first. */
  function goTo(idx) {
    if (phase !== 'idle') onUnload?.(index);
    load(idx);
  }

  /** Force a win on the current level (useful for skip-cheat / debug). */
  function advance() {
    if (phase === 'playing') beginTransition('win');
  }

  /** Force a restart of the current level. */
  function restart() {
    if (phase !== 'idle') onUnload?.(index);
    load(index);
  }

  /** Read-only snapshot for HUD / save wiring. */
  function getState() {
    return {
      level: index + 1, // 1-based for display
      levelIndex: index,
      totalLevels,
      phase,
      cleared: [...cleared],
      transitionRemaining:
        phase === 'win-transition' || phase === 'lose-transition'
          ? Math.max(0, transitionSec - transitionT)
          : 0,
    };
  }

  return { update, goTo, advance, restart, getState };
}

// Usage:
//   import { createLevelOrchestrator } from './level-orchestrator.jsx';
//   import { createWaveSystem }        from './wave-spawner.jsx';
//
//   let waves;
//   const orch = createLevelOrchestrator({
//     levels: [
//       { name: 'Grasslands', waveCount: 3 },
//       { name: 'Lava Rift',  waveCount: 5 },
//       { name: 'Void Core',  waveCount: 8 },
//     ],
//     onLoad(def, idx) {
//       loadMap(def.name);
//       waves = createWaveSystem({
//         waves: def.waveCount,
//         spawn: (spec) => spawnEnemy(spec),
//         isAlive: (e) => e.userData.hp > 0,
//         despawn: (e) => scene.remove(e),
//         onAllCleared: () => orch.advance(),
//       });
//       showBanner(`Level ${idx + 1}: ${def.name}`);
//     },
//     onUnload(idx) { clearScene(); },
//     onWin(idx)    { showBanner('Level complete!'); },
//     onLose(idx)   { showBanner('Try again!'); },
//     onComplete()  { showBanner('YOU WIN'); },
//     transitionSec: 2,
//   });
//
//   function onUpdate(dt) {
//     orch.update(dt);
//     waves?.update(dt);
//   }
//   window.__game.debug.snapshot = () => orch.getState();
//   // => { level: 2, totalLevels: 3, phase: 'playing', cleared: [0], ... }
