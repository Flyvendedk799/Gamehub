// when_to_use: Escalating wave / difficulty system — engine-agnostic, driven by
// an explicit update(dt) you call from the render loop. Reach for this when a
// game needs rounds of enemies that get harder over time instead of a flat
// constant trickle. It owns the spawn timers, wave transitions, alive-count
// tracking, and the difficulty multiplier it stamps onto each spawn spec
// (count/speed/hp). Telegraphs the next wave with a configurable lead time so
// arrivals aren't a surprise. Pairs with enemy-ai.jsx brains.

/** Build a wave controller. You provide spawn/despawn/isAlive callbacks; the
 *  controller decides WHEN and HOW MANY to spawn and how hard they are.
 *
 *  config:
 *    spawn(spec)      -> create one enemy from spec, return its handle
 *    despawn(handle)  -> (optional) remove an enemy you reported dead
 *    isAlive(handle)  -> bool; polled to recount survivors each update
 *    waves            -> total waves (default Infinity = endless)
 *    baseCount        -> enemies in wave 1 (default 4)
 *    baseInterval     -> seconds between spawns within a wave (default 0.8)
 *    difficulty       -> (wave) => multiplier (default w => 1.15 ** (w-1))
 *    telegraphSec     -> warning lead before a wave starts (default 2)
 *    onWaveStart(w, info)  onWaveCleared(w)  onAllCleared()
 *
 *  Each spawn() receives a spec carrying the live multiplier so enemies scale:
 *    { wave, index, difficulty, count, speed, hp }
 */
export function createWaveSystem(config = {}) {
  const {
    spawn,
    despawn,
    isAlive,
    waves = Number.POSITIVE_INFINITY,
    baseCount = 4,
    baseInterval = 0.8,
    difficulty = (w) => 1.15 ** (w - 1),
    telegraphSec = 2,
    baseSpeed = 4,
    baseHp = 10,
    onWaveStart,
    onWaveCleared,
    onAllCleared,
  } = config;

  let wave = 0; // 0 = before wave 1
  let phase = 'idle'; // 'idle' | 'telegraph' | 'spawning' | 'fighting' | 'done'
  let phaseT = 0;
  let spawnT = 0;
  let spawnedThisWave = 0;
  let countThisWave = 0;
  let alive = 0;
  const handles = [];

  function beginTelegraph() {
    phase = 'telegraph';
    phaseT = 0;
  }

  function startWave(w) {
    wave = w;
    const mult = difficulty(w);
    countThisWave = Math.max(1, Math.round(baseCount * mult));
    spawnedThisWave = 0;
    spawnT = 0;
    phase = 'spawning';
    phaseT = 0;
    onWaveStart?.(w, { count: countThisWave, difficulty: mult });
  }

  function spawnOne() {
    const mult = difficulty(wave);
    const spec = {
      wave,
      index: spawnedThisWave,
      difficulty: mult,
      count: countThisWave,
      speed: baseSpeed * mult,
      hp: Math.round(baseHp * mult),
    };
    const handle = spawn?.(spec);
    if (handle !== undefined && handle !== null) handles.push(handle);
    spawnedThisWave += 1;
  }

  function recountAlive() {
    if (!isAlive) {
      alive = handles.length;
      return;
    }
    let n = 0;
    for (let i = handles.length - 1; i >= 0; i--) {
      if (isAlive(handles[i])) {
        n += 1;
      } else {
        despawn?.(handles[i]);
        handles.splice(i, 1);
      }
    }
    alive = n;
  }

  /** Advance timers + wave state machine. Call once per frame with seconds. */
  function update(dt) {
    phaseT += dt;
    switch (phase) {
      case 'idle':
        beginTelegraph();
        break;
      case 'telegraph':
        if (phaseT >= telegraphSec) startWave(wave + 1);
        break;
      case 'spawning': {
        spawnT += dt;
        // Spawn cadence tightens slightly as difficulty climbs.
        const interval = baseInterval / Math.sqrt(difficulty(wave));
        while (spawnedThisWave < countThisWave && spawnT >= interval) {
          spawnT -= interval;
          spawnOne();
        }
        recountAlive();
        if (spawnedThisWave >= countThisWave) {
          phase = 'fighting';
          phaseT = 0;
        }
        break;
      }
      case 'fighting':
        recountAlive();
        if (alive === 0) {
          onWaveCleared?.(wave);
          if (wave >= waves) {
            phase = 'done';
            onAllCleared?.();
          } else {
            beginTelegraph();
          }
        }
        break;
      default:
        break;
    }
  }

  /** Read-only snapshot for HUD + playtest verification. */
  function getState() {
    return {
      wave,
      phase,
      alive,
      spawnedThisWave,
      countThisWave,
      difficulty: difficulty(Math.max(wave, 1)),
      telegraphRemaining: phase === 'telegraph' ? Math.max(0, telegraphSec - phaseT) : 0,
    };
  }

  return {
    update,
    getState,
    recountAlive,
    reset() {
      wave = 0;
      phase = 'idle';
      phaseT = 0;
      spawnT = 0;
      spawnedThisWave = 0;
      countThisWave = 0;
      alive = 0;
      handles.length = 0;
    },
  };
}

/** Time-based endless escalation (no discrete waves). Difficulty rises smoothly
 *  with elapsed time and the controller drip-spawns to hold a target population
 *  that grows over time. update(dt) from the loop; getState() for the HUD. */
export function endlessRamp(config = {}) {
  const {
    spawn,
    despawn,
    isAlive,
    rampSec = 30, // seconds for difficulty to roughly double
    baseSpawnInterval = 1.5,
    basePopulation = 4,
    maxPopulation = 40,
    baseSpeed = 4,
    baseHp = 10,
  } = config;

  let elapsed = 0;
  let spawnT = 0;
  let alive = 0;
  const handles = [];

  function diffAt(t) {
    return 2 ** (t / rampSec);
  }

  function recountAlive() {
    let n = 0;
    for (let i = handles.length - 1; i >= 0; i--) {
      if (!isAlive || isAlive(handles[i])) {
        n += 1;
      } else {
        despawn?.(handles[i]);
        handles.splice(i, 1);
      }
    }
    alive = n;
  }

  function update(dt) {
    elapsed += dt;
    const mult = diffAt(elapsed);
    const targetPop = Math.min(maxPopulation, Math.round(basePopulation * mult));
    const interval = baseSpawnInterval / mult;
    recountAlive();
    spawnT += dt;
    while (alive < targetPop && spawnT >= interval) {
      spawnT -= interval;
      const spec = {
        elapsed,
        difficulty: mult,
        speed: baseSpeed * mult,
        hp: Math.round(baseHp * mult),
      };
      const handle = spawn?.(spec);
      if (handle !== undefined && handle !== null) handles.push(handle);
      alive += 1;
    }
  }

  function getState() {
    return {
      elapsed,
      alive,
      difficulty: diffAt(elapsed),
      targetPopulation: Math.min(maxPopulation, Math.round(basePopulation * diffAt(elapsed))),
    };
  }

  return { update, getState, recountAlive };
}

// Usage:
//   import { createWaveSystem } from './wave-spawner.jsx';
//   import { makeEnemyBrain } from './enemy-ai.jsx';
//   const waves = createWaveSystem({
//     waves: 8,
//     spawn(spec) {
//       const e = makeEnemyMesh();              // spec.speed / spec.hp scale up
//       e.userData = { hp: spec.hp, speed: spec.speed, kind: 'charger',
//                      brain: makeEnemyBrain('charger') };
//       scene.add(e); return e;
//     },
//     isAlive: (e) => e.userData.hp > 0,
//     despawn: (e) => scene.remove(e),
//     onWaveStart: (w) => showBanner(`WAVE ${w}`),
//     onAllCleared: () => showBanner('CLEARED'),
//   });
//   function onUpdate(dt) {
//     waves.update(dt);
//     // ...move/brain each living enemy with player.position...
//   }
//   // Surface escalation for playtests so the ramp is verifiable:
//   window.__game.debug.snapshot = () => {
//     const s = waves.getState();
//     return { wave: s.wave, alive: s.alive, difficulty: s.difficulty,
//              phase: s.phase, spawnedThisWave: s.spawnedThisWave };
//   };
