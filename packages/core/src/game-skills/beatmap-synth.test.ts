import { describe, expect, it } from 'vitest';
// Import the SKILL module directly (the same ESM the agent imports at runtime) so
// the test exercises the real generator, not a re-implementation.
import { createBeatmapSynth, generateBeatmap } from './phaser/beatmap-synth.js';

describe('generateBeatmap (rhythm asset substrate)', () => {
  it('is deterministic per seed and varies across seeds', () => {
    const a = generateBeatmap({ seed: 7, bars: 8 });
    const b = generateBeatmap({ seed: 7, bars: 8 });
    const c = generateBeatmap({ seed: 8, bars: 8 });
    expect(a.notes).toEqual(b.notes); // same seed → identical chart
    expect(a.notes).not.toEqual(c.notes); // different seed → different chart
  });

  it('puts a note on every strong beat (bar start) and keeps lanes/time in range', () => {
    const bpm = 120;
    const bars = 6;
    const beatsPerBar = 4;
    const lanes = 4;
    const bm = generateBeatmap({ bpm, bars, beatsPerBar, lanes, density: 0.4, seed: 3 });
    expect(bm.bpm).toBe(bpm);
    expect(bm.lanes).toBe(lanes);
    const secPerBeat = 60 / bpm;
    // Every bar-start beat (0, 4, 8, …) must carry a note.
    for (let bar = 0; bar < bars; bar++) {
      const t = Math.round(bar * beatsPerBar * secPerBeat * 1000) / 1000;
      expect(bm.notes.some((n) => Math.abs(n.timeSec - t) < 1e-6)).toBe(true);
    }
    for (const n of bm.notes) {
      expect(n.lane).toBeGreaterThanOrEqual(0);
      expect(n.lane).toBeLessThan(lanes);
      expect(n.timeSec).toBeGreaterThanOrEqual(0);
      expect(n.timeSec).toBeLessThanOrEqual(bm.durationSec);
      expect(typeof n.midi).toBe('number');
    }
  });

  it('emits chronologically sorted notes', () => {
    const bm = generateBeatmap({ seed: 42, bars: 12, density: 0.8 });
    for (let i = 1; i < bm.notes.length; i++) {
      expect(bm.notes[i]!.timeSec).toBeGreaterThanOrEqual(bm.notes[i - 1]!.timeSec);
    }
  });

  it('scales note count with density (sparse < busy), strong beats always present', () => {
    const sparse = generateBeatmap({ seed: 5, bars: 16, density: 0 });
    const busy = generateBeatmap({ seed: 5, bars: 16, density: 1 });
    // density 0 → exactly the strong beats (one per bar).
    expect(sparse.notes.length).toBe(16);
    expect(busy.notes.length).toBeGreaterThan(sparse.notes.length);
  });

  it('clamps nonsense inputs instead of throwing', () => {
    const bm = generateBeatmap({
      bpm: -5,
      lanes: 999,
      bars: 0,
      density: 5,
      seed: Number.NaN as unknown as number,
    });
    expect(bm.bpm).toBeGreaterThanOrEqual(50);
    expect(bm.lanes).toBeLessThanOrEqual(8);
    expect(bm.notes.length).toBeGreaterThan(0);
  });

  it('exposes a player factory (createBeatmapSynth) without needing audio at construct time', () => {
    // Construction must not touch the Web Audio API (only start() does), so it is
    // safe to build in a headless environment; start()/stop() run in the browser.
    const synth = createBeatmapSynth({ seed: 1, bars: 4 });
    expect(typeof synth.start).toBe('function');
    expect(typeof synth.audioTime).toBe('function');
    expect(typeof synth.judge).toBe('function');
    expect(synth.beatmap.notes.length).toBeGreaterThan(0);
    expect(synth.isStarted()).toBe(false);
  });
});
