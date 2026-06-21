// when_to_use: Real audio-driven timing for rhythm and music games — reach for
// this when notes must land in sync with an actual audio track, not a synthetic
// clock. createMusicSync decodes a project-relative audio file via the Web
// Audio API and derives beat/bar position from true playback time, so drift is
// impossible. Pairs with rhythm-clock.js (which runs off scene.time) when you
// want beat-pulse visuals without blocking on load; swap in music-sync once the
// track is ready so judgements snap to the real waveform. Use judge() inside
// your key/tap handler to get perfect/good/miss ratings locked to audioTime().
// NOTE: the track URL must be a project-relative path (e.g. 'assets/audio/song.mp3')
// — the sandbox CSP is connect-src 'self', so cross-origin audio URLs will fail.

/**
 * Create a Web Audio driven music-sync controller.
 *
 * opts:
 *   url        project-relative path to the audio file (SAME-ORIGIN only)
 *   bpm        beats per minute of the track
 *   offsetMs   ms of silence / lead-in before beat 0 (default 0)
 *   beatmap    array of { timeSec, lane } note descriptors (optional)
 *   perfectMs  half-window for a 'perfect' judgement in ms (default 45)
 *   goodMs     half-window for a 'good' judgement in ms (default 110)
 *
 * Returns { load, play, pause, stop, audioTime, beatInfo, judge, nextNote, getState, destroy }.
 */
export function createMusicSync(opts = {}) {
  const bpm = opts.bpm ?? 120;
  const offsetMs = opts.offsetMs ?? 0;
  const beatmap = opts.beatmap ?? [];
  const perfectMs = opts.perfectMs ?? 45;
  const goodMs = opts.goodMs ?? 110;
  const secPerBeat = 60 / bpm;

  // Web Audio context + nodes — null until load() is called.
  let ctx = null;
  let buffer = null;
  let sourceNode = null;

  // Playback tracking.
  let startAt = 0;    // audioContext.currentTime when play() was last called
  let pausedAt = 0;   // elapsed seconds when paused
  let playing = false;
  let loaded = false;

  // Fallback wall-clock for environments where AudioContext is unavailable.
  let fallbackBase = 0;
  let fallbackPausedAt = 0;
  let useFallback = false;

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  function _createContext() {
    try {
      const AC = globalThis.AudioContext ?? globalThis.webkitAudioContext;
      if (!AC) throw new Error('no AudioContext');
      ctx = new AC();
      return true;
    } catch {
      useFallback = true;
      return false;
    }
  }

  function _destroySource() {
    if (sourceNode) {
      try {
        sourceNode.disconnect();
        sourceNode.stop(0);
      } catch {
        // already stopped — ignore
      }
      sourceNode = null;
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Fetch and decode the audio file. Must be called (and awaited) before play().
   * The URL must be a same-origin path — the sandbox CSP blocks cross-origin fetches.
   * Falls back to a performance.now() clock if AudioContext is unavailable.
   */
  async function load() {
    if (!_createContext()) {
      // Fallback mode — game still runs, timing uses performance.now().
      loaded = true;
      return;
    }
    try {
      const res = await fetch(opts.url);
      if (!res.ok) throw new Error(`audio fetch failed: ${res.status}`);
      const arrayBuffer = await res.arrayBuffer();
      buffer = await ctx.decodeAudioData(arrayBuffer);
      loaded = true;
    } catch (err) {
      console.warn('[music-sync] load failed, falling back to performance.now() clock:', err);
      useFallback = true;
      loaded = true;
    }
  }

  /** Start (or resume) playback from the current pause position. */
  function play() {
    if (!loaded) {
      console.warn('[music-sync] call load() before play()');
      return;
    }
    if (playing) return;

    if (useFallback || !ctx || !buffer) {
      fallbackBase = performance.now() / 1000 - fallbackPausedAt;
      playing = true;
      return;
    }

    // Resume AudioContext if it was suspended (browser autoplay policy).
    if (ctx.state === 'suspended') ctx.resume();

    _destroySource();
    sourceNode = ctx.createBufferSource();
    sourceNode.buffer = buffer;
    sourceNode.connect(ctx.destination);
    startAt = ctx.currentTime - fallbackPausedAt;
    sourceNode.start(0, fallbackPausedAt);
    playing = true;
  }

  /** Pause playback, preserving the current position for resume. */
  function pause() {
    if (!playing) return;
    fallbackPausedAt = audioTime();
    playing = false;
    if (useFallback || !ctx) return;
    _destroySource();
    if (ctx.state === 'running') ctx.suspend();
  }

  /** Stop playback and rewind to the beginning. */
  function stop() {
    playing = false;
    fallbackPausedAt = 0;
    pausedAt = 0;
    startAt = 0;
    _destroySource();
    if (ctx && ctx.state === 'suspended') ctx.resume(); // unlock for next play()
  }

  /**
   * Current playback position in seconds — the authoritative clock.
   * All beat math and judgements derive from this value.
   */
  function audioTime() {
    if (!playing) return fallbackPausedAt;
    if (useFallback || !ctx) {
      return performance.now() / 1000 - fallbackBase;
    }
    return ctx.currentTime - startAt;
  }

  /**
   * Beat information derived from the real playback clock.
   * Returns { beat, bar, beatPhase } where beat is the integer beat count,
   * bar is the 4/4 bar number, and beatPhase is 0..1 within the current beat.
   */
  function beatInfo() {
    const t = Math.max(0, audioTime() - offsetMs / 1000);
    const beatFloat = t / secPerBeat;
    const beat = Math.floor(beatFloat);
    const beatPhase = beatFloat - beat;
    const bar = Math.floor(beat / 4);
    return { beat, bar, beatPhase: Number(beatPhase.toFixed(3)) };
  }

  /**
   * Judge a player input fired right now against the nearest note in the beatmap
   * (if provided) or the nearest beat boundary (fallback).
   * Returns { rating: 'perfect'|'good'|'miss', noteIndex, offsetMs }
   * where noteIndex is the beatmap index of the target note (-1 if beat-boundary mode).
   */
  function judge(nowSec) {
    const t = nowSec ?? audioTime();

    if (beatmap.length > 0) {
      // Find the nearest note to t (upcoming or very recently passed).
      let bestIdx = 0;
      let bestDist = Number.POSITIVE_INFINITY;
      for (let i = 0; i < beatmap.length; i++) {
        const d = Math.abs(beatmap[i].timeSec - t);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }
      const distMs = bestDist * 1000;
      let rating = 'miss';
      if (distMs <= perfectMs) rating = 'perfect';
      else if (distMs <= goodMs) rating = 'good';
      return { rating, noteIndex: bestIdx, offsetMs: Math.round(distMs) };
    }

    // No beatmap — judge against the nearest beat boundary.
    const beatFloat = Math.max(0, t - offsetMs / 1000) / secPerBeat;
    const nearest = Math.round(beatFloat);
    const distMs = Math.abs((nearest - beatFloat) * secPerBeat) * 1000;
    let rating = 'miss';
    if (distMs <= perfectMs) rating = 'perfect';
    else if (distMs <= goodMs) rating = 'good';
    return { rating, noteIndex: -1, offsetMs: Math.round(distMs) };
  }

  /**
   * Return the next unplayed note in the beatmap that arrives after nowSec
   * (default: audioTime()), plus its timing window edges.
   * Returns null when past the last note.
   */
  function nextNote(nowSec) {
    const t = nowSec ?? audioTime();
    for (let i = 0; i < beatmap.length; i++) {
      const n = beatmap[i];
      if (n.timeSec >= t) {
        return {
          ...n,
          index: i,
          inMs: Math.round((n.timeSec - t) * 1000),
          perfectWindowMs: perfectMs,
          goodWindowMs: goodMs,
        };
      }
    }
    return null;
  }

  /**
   * Debug snapshot — wire into window.__game.debug.track so playtests can
   * confirm audio timing is live and beat counts are advancing.
   */
  function getState() {
    const { beat, bar, beatPhase } = beatInfo();
    return {
      audioTime: Number(audioTime().toFixed(3)),
      beat,
      bar,
      beatPhase,
      playing,
      loaded,
      useFallback,
    };
  }

  /** Release the AudioContext and all nodes. Call on scene shutdown. */
  function destroy() {
    _destroySource();
    if (ctx) {
      ctx.close().catch(() => {});
      ctx = null;
    }
    buffer = null;
    playing = false;
  }

  return { load, play, pause, stop, audioTime, beatInfo, judge, nextNote, getState, destroy };
}

// Usage:
//   import { createMusicSync } from './engine/music-sync.js';
//   // create() — track must be a same-origin path (CSP: connect-src 'self'):
//   this.sync = createMusicSync({
//     url: 'assets/audio/song.mp3',   // project-relative, NOT a CDN URL
//     bpm: 128,
//     offsetMs: 200,                  // ms of silence before beat 0
//     beatmap: [                      // generated from your DAW or a JSON file
//       { timeSec: 0.5,  lane: 0 },
//       { timeSec: 1.0,  lane: 1 },
//       { timeSec: 1.5,  lane: 0 },
//     ],
//   });
//
//   // preload() / async create():
//   await this.sync.load();
//   this.sync.play();
//
//   // On player key press (in your input handler, NOT update()):
//   onKeyDown(event) {
//     const lane = laneForKey(event.key);
//     const { rating, noteIndex, offsetMs } = this.sync.judge();
//     this.hud.showRating(rating); // 'perfect' / 'good' / 'miss'
//     if (rating !== 'miss') this.score += rating === 'perfect' ? 300 : 100;
//   }
//
//   // Peek at the next arriving note to animate a note-highway:
//   update(time, delta) {
//     const next = this.sync.nextNote();
//     if (next) this.noteHighway.setTarget(next.lane, next.inMs);
//   }
//
//   // Wire into debug panel so playtests can verify audio is live:
//   window.__game.debug.track({ music: () => this.sync.getState() });
//   // -> { audioTime, beat, bar, beatPhase, playing, loaded, useFallback }
//
//   // Pair with rhythm-clock for visual beat-pulse BEFORE audio loads:
//   import { createRhythmClock } from './engine/rhythm-clock.js';
//   this.clock = createRhythmClock(this, { bpm: 128, onBeat: (i) => this.flash(i) });
//   this.clock.start();
//   // Once sync.load() resolves, rhythm-clock stays for visuals; sync drives judgements.
