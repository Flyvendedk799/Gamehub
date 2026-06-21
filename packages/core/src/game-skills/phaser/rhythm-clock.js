// when_to_use: Beat-synchronized rhythm clock for music/timing games — reach
// for this when the game needs to fire events on beat, judge player input
// against a musical grid, or sync visual effects to a BPM. createRhythmClock
// runs off scene.time (no Audio API dependency) so it works even before sound
// loads. scheduleOnBeat registers callbacks at specific beat numbers;
// judgeInput computes a perfect/good/miss rating for the nearest upcoming beat;
// getBeatProgress returns a 0-1 pulse you can drive sprite scaling or trail
// opacity from. Pair with Phaser's Web Audio manager for actual sound playback.

/**
 * Create a rhythm/beat clock.
 *
 * config:
 *   bpm           beats per minute (default 120)
 *   offset        delay in ms before beat 0 fires (default 0 — for audio sync)
 *   perfectWindow half-width in ms for a "perfect" judgement (default 50)
 *   goodWindow    half-width in ms for a "good" judgement (default 120)
 *   onBeat        optional callback(beatIndex) fired on every beat
 *
 * Returns { start, stop, update(delta), judgeInput, scheduleOnBeat,
 *           getBeatProgress, getState }.
 *
 * IMPORTANT: call clock.update(delta) from your scene update() method.
 */
export function createRhythmClock(scene, config = {}) {
  const bpm = config.bpm ?? 120;
  const offset = config.offset ?? 0;
  const perfectWindow = config.perfectWindow ?? 50;
  const goodWindow = config.goodWindow ?? 120;

  const msPerBeat = (60 / bpm) * 1000;

  const state = {
    running: false,
    elapsed: 0, // ms since start (adjusted for offset)
    beatIndex: -1, // integer index of the last beat that fired
    beatProgress: 0, // 0..1 position between current beat and next
  };

  // Map of beat-index -> array of callbacks.
  const scheduled = new Map();

  function _fireBeat(idx) {
    state.beatIndex = idx;
    config.onBeat?.(idx);
    const cbs = scheduled.get(idx);
    if (cbs) {
      for (const cb of cbs) cb(idx);
    }
    // Support repeating schedules keyed with a modulo pattern.
    for (const [key, callbacks] of scheduled) {
      if (typeof key === 'string' && key.startsWith('every:')) {
        const n = Number(key.slice(6));
        if (!Number.isNaN(n) && n > 0 && idx % n === 0) {
          for (const cb of callbacks) cb(idx);
        }
      }
    }
  }

  /** Drive from scene update(). delta is milliseconds. */
  function update(delta) {
    if (!state.running) return;
    state.elapsed += delta;
    const adjustedMs = state.elapsed - offset;
    if (adjustedMs < 0) return;

    const beatFloat = adjustedMs / msPerBeat;
    const beatNow = Math.floor(beatFloat);
    state.beatProgress = beatFloat - beatNow;

    if (beatNow > state.beatIndex) {
      _fireBeat(beatNow);
    }
  }

  /** Register a callback for a specific beat index or a repeating pattern.
   *  Use a number for a one-shot beat; use 'every:N' for every Nth beat.
   *  e.g. scheduleOnBeat(4, fn) or scheduleOnBeat('every:2', fn) */
  function scheduleOnBeat(beatKey, callback) {
    if (!scheduled.has(beatKey)) scheduled.set(beatKey, []);
    scheduled.get(beatKey).push(callback);
  }

  /**
   * Judge an input event fired NOW against the nearest upcoming beat.
   * Returns { rating: 'perfect'|'good'|'miss', beatIndex, offsetMs }.
   * Call this inside your keyboard/pointer handler (not update()).
   */
  function judgeInput() {
    const adjustedMs = state.elapsed - offset;
    const beatFloat = adjustedMs / msPerBeat;
    // Distance to nearest beat (current or next).
    const nearestBeat = Math.round(beatFloat);
    const offsetMs = Math.abs((nearestBeat - beatFloat) * msPerBeat);
    let rating = 'miss';
    if (offsetMs <= perfectWindow) rating = 'perfect';
    else if (offsetMs <= goodWindow) rating = 'good';
    return { rating, beatIndex: nearestBeat, offsetMs: Math.round(offsetMs) };
  }

  /** 0..1 pulse you can map to visual scale/alpha. Peaks at 0 (on beat). */
  function getBeatProgress() {
    return state.beatProgress;
  }

  /**
   * Build a Phaser tween that pulses a target's scale on every beat.
   * Pass the sprite/image/text you want to throb, and a peak scale factor.
   */
  function addBeatPulse(target, peakScale = 1.08) {
    // Replaces itself on every beat so the tween stays in sync.
    function pulse() {
      if (!state.running) return;
      scene.tweens.add({
        targets: target,
        scaleX: peakScale,
        scaleY: peakScale,
        duration: msPerBeat * 0.25,
        yoyo: true,
        ease: 'Sine.easeOut',
        onComplete: () => {
          // Schedule next pulse for the next beat.
          const remaining = msPerBeat * (1 - state.beatProgress);
          scene.time.delayedCall(remaining, pulse);
        },
      });
    }
    // Start immediately on the next beat boundary.
    const toNext = msPerBeat * (1 - state.beatProgress);
    scene.time.delayedCall(toNext, pulse);
  }

  return {
    start() {
      state.running = true;
      state.elapsed = 0;
      state.beatIndex = -1;
    },
    stop() {
      state.running = false;
    },
    update,
    judgeInput,
    scheduleOnBeat,
    getBeatProgress,
    addBeatPulse,
    getState() {
      return {
        bpm,
        running: state.running,
        beatIndex: state.beatIndex,
        beatProgress: Number(state.beatProgress.toFixed(3)),
        elapsedMs: Math.round(state.elapsed),
      };
    },
  };
}

// Usage:
//   import { createRhythmClock } from './engine/rhythm-clock.js';
//   // create():
//   this.clock = createRhythmClock(this, {
//     bpm: 128,
//     perfectWindow: 45,
//     goodWindow: 110,
//     onBeat: (idx) => {
//       this.bg.setAlpha(1);          // flash on every beat
//       scene.time.delayedCall(60, () => this.bg.setAlpha(0.7));
//       if (idx % 4 === 0) spawnObstacle(); // every 4th beat
//     },
//   });
//   this.clock.scheduleOnBeat('every:8', (idx) => this.speedUp());
//   this.clock.addBeatPulse(this.logo, 1.1);
//   this.clock.start();
//   // update(time, delta):
//   this.clock.update(delta);
//   // On player tap:
//   onTap() {
//     const { rating, offsetMs } = this.clock.judgeInput();
//     this.hud.showRating(rating); // 'perfect' / 'good' / 'miss'
//   }
//
//   //   window.__game.debug.snapshot = () => this.clock.getState();
//   //   // -> { bpm, running, beatIndex, beatProgress, elapsedMs }
