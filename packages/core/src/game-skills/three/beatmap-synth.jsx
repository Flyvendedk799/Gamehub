// when_to_use: A self-contained rhythm substrate — GENERATE a playable beatmap
// AND hear it, with ZERO audio files. Reach for this for any rhythm/music/timing
// game: generateBeatmap() returns a deterministic note chart ({ bpm, lanes, notes:
// [{ timeSec, lane, midi }] }) and createBeatmapSynth() plays that chart as a
// procedural chiptune via the Web Audio API (an oscillator per note + a kick on
// every beat) — so the MUSIC *is* the chart and a rhythm game is never silent or
// faked, with no licensed track and no cross-origin fetch (CSP connect-src 'self'
// safe). audioTime() exposes the true AudioContext clock and judge(lane) rates a
// hit perfect/good/miss against it. The generated `beatmap` is also drop-in for
// music-sync.js's `beatmap` option if you later add a real same-origin track.

/** Deterministic small PRNG (mulberry32) so a given seed always yields the same
 *  chart — reproducible playtests + a stable game per seed. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clampNum(v, lo, hi, dflt) {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : dflt;
  return n < lo ? lo : n > hi ? hi : n;
}
function clampInt(v, lo, hi, dflt) {
  return Math.round(clampNum(v, lo, hi, dflt));
}
function round3(n) {
  return Math.round(n * 1000) / 1000;
}

/**
 * Generate a deterministic, musically-patterned beatmap. Pure — no audio, no DOM.
 *
 * opts: { bpm=120, lanes=4, bars=16, beatsPerBar=4, density=0.5 (0..1 note
 *   probability on weak beats), offsetMs=0 (lead-in silence), seed=1 }
 *
 * Returns { bpm, beatsPerBar, lanes, offsetMs, durationSec, seed,
 *           notes: [{ timeSec, beat, lane, midi }] } sorted by time. Strong beats
 * (bar starts) always carry a note; weaker beats fire at `density`; busy charts
 * add off-beat eighth notes. Pitches walk a pentatonic scale so the synth sounds
 * tuneful rather than random.
 */
export function generateBeatmap(opts = {}) {
  const bpm = clampNum(opts.bpm, 50, 260, 120);
  const lanes = clampInt(opts.lanes, 1, 8, 4);
  const bars = clampInt(opts.bars, 1, 256, 16);
  const beatsPerBar = clampInt(opts.beatsPerBar, 1, 16, 4);
  const density = clampNum(opts.density, 0, 1, 0.5);
  const offsetMs = clampNum(opts.offsetMs, 0, 100000, 0);
  const seed = (typeof opts.seed === 'number' ? opts.seed : 1) >>> 0;
  const rand = mulberry32(seed || 1);
  const secPerBeat = 60 / bpm;
  const totalBeats = bars * beatsPerBar;
  const PENT = [0, 2, 4, 7, 9]; // major pentatonic semitone offsets
  const root = 60; // C4
  const notes = [];
  let lane = Math.floor(rand() * lanes);

  for (let b = 0; b < totalBeats; b++) {
    const strong = b % beatsPerBar === 0;
    if (strong || rand() < density) {
      // Melodic continuity — usually step a lane, occasionally leap.
      if (!strong && rand() < 0.6) {
        lane = clampInt(lane + (rand() < 0.5 ? -1 : 1), 0, lanes - 1, lane);
      } else {
        lane = Math.floor(rand() * lanes);
      }
      const midi = root + PENT[(lane + b) % PENT.length] + (strong ? 0 : 0);
      notes.push({ timeSec: round3(offsetMs / 1000 + b * secPerBeat), beat: b, lane, midi });
    }
    // Off-beat (eighth) embellishment for busier charts.
    if (density > 0.55 && rand() < density - 0.5) {
      const oLane = Math.floor(rand() * lanes);
      notes.push({
        timeSec: round3(offsetMs / 1000 + (b + 0.5) * secPerBeat),
        beat: b + 0.5,
        lane: oLane,
        midi: root + 12 + PENT[(oLane + b) % PENT.length],
      });
    }
  }

  notes.sort((a, z) => a.timeSec - z.timeSec || a.lane - z.lane);
  return {
    bpm,
    beatsPerBar,
    lanes,
    offsetMs,
    durationSec: round3(offsetMs / 1000 + totalBeats * secPerBeat),
    seed,
    notes,
  };
}

function midiToFreq(m) {
  return 440 * 2 ** ((m - 69) / 12);
}

/**
 * Play a beatmap as a procedural chiptune and judge input against the true audio
 * clock. Browser-only (uses the Web Audio API). If no `beatmap` is supplied one
 * is generated from the same opts.
 *
 * opts: { beatmap?, master=0.3, perfectMs=45, goodMs=110, ...generateBeatmap opts }
 *
 * Returns { beatmap, start, stop, audioTime, judge, upcoming, isStarted }.
 *   - start()           schedules every note + a kick on each beat, then plays.
 *   - audioTime()       seconds since the chart's first note (the real AC clock).
 *   - judge(lane, t?)   rate the nearest un-hit note in `lane` (null = any lane):
 *                       { rating:'perfect'|'good'|'miss', deltaMs, note? }.
 *   - upcoming(within)  un-hit notes arriving within `within` seconds (spawn cue).
 */
export function createBeatmapSynth(opts = {}) {
  const beatmap = opts.beatmap || generateBeatmap(opts);
  const master = clampNum(opts.master, 0, 1, 0.3);
  const perfectMs = clampNum(opts.perfectMs, 5, 500, 45);
  const goodMs = clampNum(opts.goodMs, 10, 1000, 110);

  let ctx = null;
  let masterGain = null;
  let startTime = 0;
  let started = false;
  const judged = new Set();

  function ensureCtx() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      masterGain = ctx.createGain();
      masterGain.gain.value = master;
      masterGain.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function tone(at, freq, dur, type, gain) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type || 'square';
    o.frequency.value = freq;
    o.connect(g);
    g.connect(masterGain);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain || 0.4, at + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.start(at);
    o.stop(at + dur + 0.02);
  }

  function start() {
    ensureCtx();
    // Anchor the chart clock 100 ms ahead so the first note isn't clipped.
    startTime = ctx.currentTime + 0.1;
    started = true;
    const secPerBeat = 60 / beatmap.bpm;
    const melodyDur = Math.min(secPerBeat * 0.9, 0.22);
    for (const n of beatmap.notes) {
      tone(
        startTime + n.timeSec,
        midiToFreq(typeof n.midi === 'number' ? n.midi : 72),
        melodyDur,
        'square',
        0.35,
      );
    }
    // Groove — a kick/bass pulse on every beat across the chart's length.
    for (let b = 0; b * secPerBeat < beatmap.durationSec; b++) {
      const at = startTime + beatmap.offsetMs / 1000 + b * secPerBeat;
      const down = b % beatmap.beatsPerBar === 0;
      tone(at, down ? 80 : 120, 0.12, 'triangle', down ? 0.5 : 0.22);
    }
    return api;
  }

  function audioTime() {
    return (ctx ? ctx.currentTime : 0) - startTime;
  }

  function judge(lane, atSec) {
    const t = typeof atSec === 'number' ? atSec : audioTime();
    let best = -1;
    let bestDt = Number.POSITIVE_INFINITY;
    for (let i = 0; i < beatmap.notes.length; i++) {
      if (judged.has(i)) continue;
      const n = beatmap.notes[i];
      if (lane != null && n.lane !== lane) continue;
      const dt = Math.abs(n.timeSec - t) * 1000;
      if (dt < bestDt) {
        bestDt = dt;
        best = i;
      }
    }
    if (best < 0 || bestDt > goodMs) {
      return {
        rating: 'miss',
        deltaMs: bestDt === Number.POSITIVE_INFINITY ? null : Math.round(bestDt),
      };
    }
    judged.add(best);
    return {
      rating: bestDt <= perfectMs ? 'perfect' : 'good',
      deltaMs: Math.round(bestDt),
      note: beatmap.notes[best],
    };
  }

  function upcoming(withinSec) {
    const t = audioTime();
    const w = typeof withinSec === 'number' ? withinSec : 2;
    const out = [];
    for (let i = 0; i < beatmap.notes.length; i++) {
      const n = beatmap.notes[i];
      if (!judged.has(i) && n.timeSec >= t && n.timeSec <= t + w) out.push(n);
    }
    return out;
  }

  function stop() {
    if (ctx) {
      try {
        ctx.close();
      } catch (e) {
        /* already closed */
      }
      ctx = null;
      started = false;
    }
  }

  const api = { beatmap, start, stop, audioTime, judge, upcoming, isStarted: () => started };
  return api;
}
