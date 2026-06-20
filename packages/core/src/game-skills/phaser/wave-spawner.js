// when_to_use: Phaser wave/difficulty system — the fix for flat games that
// never get harder. Reach for this whenever a generated game spawns enemies:
// instead of one static blob, this drives ESCALATING waves where each wave has
// more enemies that are faster and tougher, with a telegraphed countdown
// between waves so the ramp is readable. createWaveSystem(scene, config) runs
// discrete waves (start next when the current clears); endlessRamp(scene,
// config) runs a time-based survival ramp (interval shrinks + speed grows).
// Both expose getState() so the HUD and window.__game.debug.snapshot() can
// prove the difficulty is actually climbing during playtests.

import * as Phaser from 'phaser';

/**
 * Discrete escalating wave controller.
 * config:
 *   spawn(spec)        -> create ONE enemy from spec {count,index,wave,speed,hp,difficulty}; return the sprite
 *   waves              total waves (default Infinity = endless waves)
 *   baseCount          enemies in wave 1 (default 4)
 *   baseIntervalMs     ms between spawns within a wave (default 600)
 *   difficulty(wave)   -> multiplier; default w => 1.15 ** (w - 1)
 *   baseSpeed / baseHp the wave-1 stats the multiplier scales (default 80 / 1)
 *   telegraphMs        countdown before each wave starts (default 2500)
 *   onWaveStart(wave, info) / onWaveCleared(wave) / onAllCleared()
 *   onCountdown(secLeft, wave)  optional, for a HUD "Wave N in 3..."
 */
export function createWaveSystem(scene, config = {}) {
  const spawn = config.spawn;
  const totalWaves = config.waves ?? Number.POSITIVE_INFINITY;
  const baseCount = config.baseCount ?? 4;
  const baseInterval = config.baseIntervalMs ?? 600;
  const difficulty = config.difficulty ?? ((w) => 1.15 ** (w - 1));
  const baseSpeed = config.baseSpeed ?? 80;
  const baseHp = config.baseHp ?? 1;
  const telegraphMs = config.telegraphMs ?? 2500;

  const state = { wave: 0, alive: 0, spawnedThisWave: 0, difficulty: 1, running: false };
  let spawnTimer = null;
  let toSpawn = 0;

  /** Begin the telegraphed countdown, then start the next wave. */
  function queueNextWave() {
    if (state.wave >= totalWaves) {
      config.onAllCleared?.();
      return;
    }
    const nextWave = state.wave + 1;
    let secLeft = Math.ceil(telegraphMs / 1000);
    config.onCountdown?.(secLeft, nextWave);
    // Tick the countdown once per second so the HUD can read the ramp coming.
    const ticker = scene.time.addEvent({
      delay: 1000,
      repeat: secLeft - 1,
      callback: () => {
        secLeft -= 1;
        config.onCountdown?.(secLeft, nextWave);
      },
    });
    scene.time.delayedCall(telegraphMs, () => {
      ticker.remove(false);
      startWave(nextWave);
    });
  }

  /** Spawn an entire wave, applying the difficulty multiplier to count+stats. */
  function startWave(wave) {
    state.wave = wave;
    state.difficulty = difficulty(wave);
    state.spawnedThisWave = 0;
    state.running = true;
    const count = Math.round(baseCount * state.difficulty);
    toSpawn = count;
    config.onWaveStart?.(wave, { count, difficulty: state.difficulty });

    // Drip enemies in over time rather than dumping them all on one frame.
    spawnTimer = scene.time.addEvent({
      delay: baseInterval,
      repeat: count - 1,
      callback: () => {
        const idx = state.spawnedThisWave;
        const spec = {
          index: idx,
          count,
          wave,
          difficulty: state.difficulty,
          // Faster + tougher every wave — this IS the escalation.
          speed: baseSpeed * state.difficulty,
          hp: Math.max(1, Math.round(baseHp * state.difficulty)),
        };
        const sprite = spawn?.(spec);
        if (sprite) {
          sprite._waveTracked = true;
          state.alive += 1;
        }
        state.spawnedThisWave += 1;
        toSpawn -= 1;
      },
    });
  }

  /** Call when an enemy dies. When the wave is fully spawned AND empty, the
   *  next wave is queued with its telegraphed countdown. */
  function notifyKilled() {
    state.alive = Math.max(0, state.alive - 1);
    if (state.running && toSpawn <= 0 && state.alive <= 0) {
      state.running = false;
      config.onWaveCleared?.(state.wave);
      queueNextWave();
    }
  }

  return {
    /** Kick off wave 1 (after its telegraph). */
    start() {
      queueNextWave();
    },
    /** Hook this to your death/overlap handler so the system tracks `alive`. */
    notifyKilled,
    /** Snapshot for HUD + window.__game.debug.snapshot(). */
    getState() {
      return {
        wave: state.wave,
        alive: state.alive,
        spawnedThisWave: state.spawnedThisWave,
        difficulty: Number(state.difficulty.toFixed(3)),
      };
    },
    /** Tear down pending timers (scene shutdown / restart). */
    destroy() {
      spawnTimer?.remove(false);
    },
  };
}

/**
 * Time-based survival ramp (no discrete waves). Spawns continuously; the
 * spawn interval shrinks and enemy speed/hp grow with elapsed seconds, so the
 * pressure rises the longer the player survives.
 * config:
 *   spawn(spec)        -> create one enemy from spec {speed,hp,elapsed,difficulty}
 *   startIntervalMs    initial gap between spawns (default 1400)
 *   minIntervalMs      floor the interval can shrink to (default 350)
 *   rampSeconds        seconds to go from start to min interval (default 90)
 *   baseSpeed / baseHp wave-1 stats (default 80 / 1)
 *   speedGrowth        speed multiplier per minute survived (default 0.5)
 */
export function endlessRamp(scene, config = {}) {
  const spawn = config.spawn;
  const startInterval = config.startIntervalMs ?? 1400;
  const minInterval = config.minIntervalMs ?? 350;
  const rampSeconds = config.rampSeconds ?? 90;
  const baseSpeed = config.baseSpeed ?? 80;
  const baseHp = config.baseHp ?? 1;
  const speedGrowth = config.speedGrowth ?? 0.5;

  const state = { wave: 0, alive: 0, spawnedThisWave: 0, difficulty: 1, elapsed: 0 };
  let acc = 0;
  let started = 0;

  /** Drive from the scene update(time, delta). dt is seconds. */
  function update(dt) {
    if (!started) started = scene.time.now;
    state.elapsed = (scene.time.now - started) / 1000;
    // Difficulty climbs with time; interval lerps toward its floor.
    const k = Math.min(state.elapsed / rampSeconds, 1);
    const interval = startInterval + (minInterval - startInterval) * k;
    state.difficulty = 1 + (state.elapsed / 60) * speedGrowth;

    acc += dt * 1000;
    if (acc >= interval) {
      acc = 0;
      const spec = {
        elapsed: state.elapsed,
        difficulty: state.difficulty,
        speed: baseSpeed * state.difficulty,
        hp: Math.max(1, Math.round(baseHp * state.difficulty)),
      };
      const sprite = spawn?.(spec);
      if (sprite) {
        sprite._waveTracked = true;
        state.alive += 1;
        state.spawnedThisWave += 1;
        state.wave = Math.floor(state.elapsed / 15) + 1; // pseudo-wave for HUD
      }
    }
  }

  return {
    update,
    notifyKilled() {
      state.alive = Math.max(0, state.alive - 1);
    },
    getState() {
      return {
        wave: state.wave,
        alive: state.alive,
        spawnedThisWave: state.spawnedThisWave,
        difficulty: Number(state.difficulty.toFixed(3)),
      };
    },
    destroy() {},
  };
}

// Usage:
//   import { createWaveSystem } from './engine/wave-spawner.js';
//   import { makeEnemyBrain } from './engine/enemy-ai.js';
//   // create():
//   this.enemies = this.physics.add.group();
//   this.waves = createWaveSystem(this, {
//     waves: 10,
//     baseCount: 4,
//     spawn: (spec) => {
//       const e = this.enemies.create(this.spawnX(), this.spawnY(), 'enemy');
//       e._brain = makeEnemyBrain(spec.wave % 3 === 0 ? 'charger' : 'chase');
//       e._speed = spec.speed; e._hp = spec.hp;       // escalated stats
//       return e;
//     },
//     onWaveStart: (w) => this.hud.setText(`Wave ${w}`),
//     onCountdown: (s, w) => this.hud.setText(s > 0 ? `Wave ${w} in ${s}` : ''),
//     onAllCleared: () => this.win(),
//   });
//   this.waves.start();
//   // on enemy death overlap: this.waves.notifyKilled();
//   // update(time, delta): drive brains with spec.speed; e._brain(e, this.player, { dt, speed: e._speed });
//
//   // Surface escalation so playtests can VERIFY it climbs:
//   //   window.__game.debug.snapshot = () => this.waves.getState();
//   //   // -> { wave, alive, spawnedThisWave, difficulty } rising over time
