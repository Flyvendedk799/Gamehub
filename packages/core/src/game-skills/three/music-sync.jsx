// when_to_use: Real audio-driven timing for Three.js rhythm and music games —
// reach for this when notes must land in sync with an actual audio track, not a
// synthetic clock. createMusicSync decodes a project-relative file via the Web
// Audio API and derives beat/bar position from true playback time, so drift is
// impossible. Call audioTime() from your render loop to position note meshes on
// a 3D note-highway; call judge() inside your input handler for perfect/good/miss
// ratings locked to the waveform. Pairs with the Phaser rhythm-clock (run it off
// requestAnimationFrame for beat-pulse effects) while audio loads; once load()
// resolves the sync controller becomes the authoritative clock. NOTE: the track
// URL must be a project-relative path (e.g. 'assets/audio/song.mp3') — the
// sandbox CSP is connect-src 'self', so cross-origin audio URLs will fail.

/**
 * Create a Web Audio driven music-sync controller (Three.js / engine-agnostic).
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
  let playing = false;
  let loaded = false;
  let resumeOffset = 0; // seconds already played before the current sourceNode started

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
   * Falls back to a performance.now() clock if AudioContext is unavailable or fetch fails.
   */
  async function load() {
    if (!_createContext()) {
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
    // Record the AudioContext time at which this source logically started at resumeOffset.
    resumeOffset = fallbackPausedAt;
    sourceNode.start(0, resumeOffset);
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
    resumeOffset = 0;
    fallbackBase = 0;
    _destroySource();
    // Unlock context for next play() call.
    if (ctx && ctx.state === 'suspended') ctx.resume();
  }

  /**
   * Current playback position in seconds — the authoritative clock.
   * Derive all beat math and note-highway positions from this value.
   */
  function audioTime() {
    if (!playing) return fallbackPausedAt;
    if (useFallback || !ctx) {
      return performance.now() / 1000 - fallbackBase;
    }
    // ctx.currentTime advances in real time once play() starts the source.
    // We started the source at ctx.currentTime (call it T0) playing from resumeOffset,
    // so elapsed = ctx.currentTime - T0, and position = elapsed + resumeOffset.
    // We capture this implicitly: position = (ctx.currentTime - ctx.currentTime|play) + resumeOffset.
    // Simpler: store the "virtual zero" for the context timeline.
    return ctx.currentTime - _contextStartTime() + resumeOffset;
  }

  // Memoised context time at which the last sourceNode.start(0, ...) fired.
  let _ctxStartRef = 0;

  function _contextStartTime() {
    return _ctxStartRef;
  }

  // Patch play() to capture _ctxStartRef — done inline below via a small wrapper.
  const _rawPlay = play;
  // (re-assigned after definition — see bottom of factory)

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
   * Judge a player input fired at nowSec (default: audioTime()) against the
   * nearest note in the beatmap, or the nearest beat boundary if no beatmap.
   * Returns { rating: 'perfect'|'good'|'miss', noteIndex, offsetMs }
   */
  function judge(nowSec) {
    const t = nowSec ?? audioTime();

    if (beatmap.length > 0) {
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
   * Return the next note in the beatmap arriving after nowSec (default: audioTime()),
   * plus milliseconds until it arrives and judgement window sizes.
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

  /** Release the AudioContext and all nodes. Call on Three.js scene dispose. */
  function destroy() {
    _destroySource();
    if (ctx) {
      ctx.close().catch(() => {});
      ctx = null;
    }
    buffer = null;
    playing = false;
  }

  // Wrap play() to capture the AudioContext reference time at the moment the
  // source node starts, so audioTime() stays accurate across pause/resume cycles.
  function playTracked() {
    if (!loaded || playing || useFallback || !ctx || !buffer) {
      _rawPlay();
      return;
    }
    if (ctx.state === 'suspended') ctx.resume();
    _destroySource();
    sourceNode = ctx.createBufferSource();
    sourceNode.buffer = buffer;
    sourceNode.connect(ctx.destination);
    resumeOffset = fallbackPausedAt;
    _ctxStartRef = ctx.currentTime;
    sourceNode.start(0, resumeOffset);
    playing = true;
  }

  return {
    load,
    play: playTracked,
    pause,
    stop,
    audioTime,
    beatInfo,
    judge,
    nextNote,
    getState,
    destroy,
  };
}

// Usage:
//   import { createMusicSync } from './engine/music-sync.jsx';
//   // Init (e.g. inside an async init() or useEffect):
//   const sync = createMusicSync({
//     url: 'assets/audio/song.mp3',   // project-relative, NOT a CDN URL (CSP: connect-src 'self')
//     bpm: 128,
//     offsetMs: 200,                  // ms of silence before beat 0
//     beatmap: [                      // array of { timeSec, lane } from your DAW / JSON export
//       { timeSec: 0.5,  lane: 0 },
//       { timeSec: 1.0,  lane: 1 },
//       { timeSec: 1.5,  lane: 0 },
//     ],
//   });
//   await sync.load();
//   sync.play();
//
//   // Three.js render loop — position note meshes using audioTime():
//   function onUpdate(dt) {
//     const t = sync.audioTime();
//     for (const mesh of noteMeshes) {
//       mesh.position.z = (mesh.userData.timeSec - t) * HIGHWAY_SPEED;
//     }
//     // Animate beat-flash on bar boundaries:
//     const { beatPhase } = sync.beatInfo();
//     glowMaterial.opacity = 1 - beatPhase;
//   }
//
//   // On player key press (NOT in the render loop):
//   window.addEventListener('keydown', (e) => {
//     const lane = { ArrowLeft: 0, ArrowRight: 1 }[e.key];
//     if (lane === undefined) return;
//     const { rating, noteIndex, offsetMs } = sync.judge();
//     hudElement.textContent = rating;                        // 'perfect' / 'good' / 'miss'
//     if (rating !== 'miss') score += rating === 'perfect' ? 300 : 100;
//   });
//
//   // Peek at the next arriving note to drive a note-highway look-ahead:
//   const next = sync.nextNote();
//   if (next) spawnNoteIndicator(next.lane, next.inMs);
//
//   // Wire into the debug panel so playtests can verify audio is live:
//   window.__game.debug.track({ music: () => sync.getState() });
//   // -> { audioTime, beat, bar, beatPhase, playing, loaded, useFallback }
//
//   // Cleanup on unmount / scene dispose:
//   sync.destroy();
