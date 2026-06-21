// when_to_use: BPM beat clock with scheduled beat callbacks and an input-timing
// judge — the core primitive for rhythm games, music-synced gameplay, and
// beat-matched effects. Drive it with update(dt) from your render loop (frame-
// accurate to ~1 ms at 60 fps) or, for sub-frame accuracy in music games, hand
// it an AudioContext so it reads currentTime directly. onBeat fires on every
// beat; scheduleOnBeat queues a one-shot callback at a future beat number.
// judgeInput(windowSec) grades a player tap as 'perfect'/'good'/'miss' relative
// to the nearest beat. Engine-agnostic: no Three.js dependency.

// ---------------------------------------------------------------------------
// Beat clock.
// ---------------------------------------------------------------------------

/** Create a BPM beat clock.
 *
 *  opts:
 *    bpm           -> beats per minute (default 120)
 *    offset        -> song start offset in seconds (default 0); dial in if
 *                     the audio track has silence at the head
 *    audioCtx      -> optional Web AudioContext; if provided, uses
 *                     audioCtx.currentTime for sub-frame accuracy
 *    onBeat(beat, t) -> fired on every beat; beat = 1-based integer, t = seconds
 *    onBar(bar, t)   -> fired on first beat of every bar (beatsPerBar beats)
 *    beatsPerBar   -> time-signature numerator (default 4)
 *
 *  Returns { update(dt), start(), stop(), reset(), getState(),
 *            scheduleOnBeat(beat, fn), judgeInput(windowSec) }
 */
export function createRhythmClock(opts = {}) {
  let bpm = opts.bpm ?? 120;
  const offset = opts.offset ?? 0;
  const audioCtx = opts.audioCtx ?? null;
  const beatsPerBar = opts.beatsPerBar ?? 4;

  let elapsed = offset; // seconds since clock epoch (adjusted for offset)
  let running = false;
  let lastBeat = 0; // last beat number that fired
  let dtAccum = 0; // accumulates dt for sub-frame beat detection

  const scheduled = []; // [{ beat: number, fn: () => void }]

  function beatInterval() {
    return 60 / bpm;
  }

  function currentElapsed() {
    if (audioCtx) return audioCtx.currentTime + offset;
    return elapsed;
  }

  /** Change BPM live (e.g. for speed-up phases). Beat count continues. */
  function setBpm(newBpm) {
    bpm = newBpm;
  }

  function start() {
    running = true;
  }
  function stop() {
    running = false;
  }

  function reset() {
    elapsed = offset;
    lastBeat = 0;
    dtAccum = 0;
    scheduled.length = 0;
    running = false;
  }

  /** Advance the clock. Call once per frame with delta seconds. */
  function update(dt) {
    if (!running) return;
    // If using AudioContext, elapsed is read from it; else accumulate dt.
    if (!audioCtx) elapsed += dt;

    const t = currentElapsed();
    const interval = beatInterval();
    const beatNow = Math.floor(t / interval) + 1; // 1-based

    // Fire every beat that elapsed since last update (catches slow frames).
    for (let b = lastBeat + 1; b <= beatNow; b++) {
      const beatT = (b - 1) * interval;
      opts.onBeat?.(b, beatT);
      if ((b - 1) % beatsPerBar === 0) opts.onBar?.(Math.floor((b - 1) / beatsPerBar) + 1, beatT);

      // Fire scheduled one-shots.
      for (let i = scheduled.length - 1; i >= 0; i--) {
        if (scheduled[i].beat <= b) {
          scheduled[i].fn(b, beatT);
          scheduled.splice(i, 1);
        }
      }
    }
    lastBeat = beatNow;
  }

  // ---------------------------------------------------------------------------
  // scheduleOnBeat.
  // ---------------------------------------------------------------------------

  /** Queue `fn` to fire once when beat number `beat` is reached.
   *  Beats are 1-based and absolute (not relative to now). */
  function scheduleOnBeat(beat, fn) {
    scheduled.push({ beat, fn });
    scheduled.sort((a, b) => a.beat - b.beat);
  }

  /** Queue `fn` to fire `beatsFromNow` beats in the future. */
  function scheduleIn(beatsFromNow, fn) {
    scheduleOnBeat(lastBeat + beatsFromNow, fn);
  }

  // ---------------------------------------------------------------------------
  // Input timing judge.
  // ---------------------------------------------------------------------------

  /**
   * Grade a player input event as 'perfect' | 'good' | 'miss'.
   *
   *  windows (seconds, half-window on each side of the beat):
   *    perfectWindow  -> default 0.05  (±50 ms)
   *    goodWindow     -> default 0.12  (±120 ms)
   *
   *  Returns { grade, beatNumber, errorSec }
   *    errorSec > 0 = late, < 0 = early
   */
  function judgeInput(overrideOpts = {}) {
    const perfectWindow = overrideOpts.perfectWindow ?? 0.05;
    const goodWindow = overrideOpts.goodWindow ?? 0.12;

    const t = currentElapsed();
    const interval = beatInterval();
    // Find nearest beat.
    const nearestBeat = Math.round(t / interval);
    const nearestBeatT = nearestBeat * interval;
    const error = t - nearestBeatT; // positive = late
    const absErr = Math.abs(error);

    let grade;
    if (absErr <= perfectWindow) {
      grade = 'perfect';
    } else if (absErr <= goodWindow) {
      grade = 'good';
    } else {
      grade = 'miss';
    }

    return { grade, beatNumber: nearestBeat + 1, errorSec: error };
  }

  // ---------------------------------------------------------------------------
  // Phase helpers (useful for syncing visuals to beats).
  // ---------------------------------------------------------------------------

  /** Float 0→1 within the current beat period (0 = beat fell, 1 = next beat). */
  function beatPhase() {
    const t = currentElapsed();
    const interval = beatInterval();
    return (t % interval) / interval;
  }

  /** Float 0→1 within the current bar. */
  function barPhase() {
    const t = currentElapsed();
    const barLen = beatInterval() * beatsPerBar;
    return (t % barLen) / barLen;
  }

  // ---------------------------------------------------------------------------
  // Combo / score helper.
  // ---------------------------------------------------------------------------

  /** A stateful combo tracker. Feed it judgeInput() results. */
  function createCombo(opts2 = {}) {
    const perfectPts = opts2.perfectPoints ?? 100;
    const goodPts = opts2.goodPoints ?? 60;
    let combo = 0;
    let best = 0;
    let score = 0;
    const totals = { perfect: 0, good: 0, miss: 0 };

    function register(grade) {
      totals[grade] = (totals[grade] ?? 0) + 1;
      if (grade === 'miss') {
        combo = 0;
      } else {
        combo += 1;
        if (combo > best) best = combo;
        const pts = grade === 'perfect' ? perfectPts : goodPts;
        score += pts * Math.max(1, Math.floor(combo / 4)); // 4× combo bonus
      }
      return { combo, score };
    }

    function getComboState() {
      return { combo, best, score, totals };
    }

    return { register, getComboState };
  }

  // ---------------------------------------------------------------------------
  // Read-only state.
  // ---------------------------------------------------------------------------

  function getState() {
    return {
      running,
      bpm,
      elapsed: currentElapsed(),
      beat: lastBeat,
      beatPhase: beatPhase(),
      bar: Math.ceil(lastBeat / beatsPerBar),
      barPhase: barPhase(),
      scheduledCount: scheduled.length,
    };
  }

  return {
    update,
    start,
    stop,
    reset,
    setBpm,
    scheduleOnBeat,
    scheduleIn,
    judgeInput,
    beatPhase,
    barPhase,
    createCombo,
    getState,
  };
}

// Usage:
//   import { createRhythmClock } from './rhythm-clock.jsx';
//
//   // With AudioContext (preferred for music games):
//   const audioCtx = new AudioContext();
//   const clock = createRhythmClock({
//     bpm: 128, audioCtx,
//     beatsPerBar: 4,
//     onBeat: (beat) => { flashLight(beat); },
//     onBar:  (bar)  => { updateBarHud(bar); },
//   });
//
//   // Or dt-only (no Web Audio):
//   const clock2 = createRhythmClock({ bpm: 140 });
//   clock2.start();
//
//   // Schedule a boss spawn on beat 32:
//   clock.scheduleOnBeat(32, () => spawnBoss());
//   // Or relative:
//   clock.scheduleIn(4, () => sfx.play('whoosh'));
//
//   // Judge player tap input:
//   document.addEventListener('keydown', (e) => {
//     if (e.code === 'Space') {
//       const { grade, errorSec } = clock.judgeInput({ perfectWindow: 0.06 });
//       hud.showGrade(grade);   // 'perfect' | 'good' | 'miss'
//       combo.register(grade);
//     }
//   });
//
//   const combo = clock.createCombo({ perfectPoints: 100, goodPoints: 50 });
//
//   function onUpdate(dt) {
//     clock.update(dt);
//     // Pulse camera scale on each beat:
//     const phase = clock.beatPhase();        // 0→1 per beat
//     camera.zoom = 1 + 0.03 * Math.cos(phase * Math.PI * 2);
//   }
//
//   window.__game.debug.snapshot = () => ({
//     ...clock.getState(),
//     ...combo.getComboState(),
//   });
//   // => { bpm: 128, beat: 16, beatPhase: 0.42, combo: 8, score: 1200, ... }
