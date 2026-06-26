/**
 * Public type surface for the `beatmap-synth` rhythm skill (the runtime JS is
 * plain ESM the agent imports into the game). Declared here so the platform's
 * own TypeScript (e.g. tests) can import the generator with full types without
 * enabling `allowJs`. The `.js` remains the single source of behaviour.
 */

export interface BeatmapNote {
  /** Note hit time in seconds from the chart start. */
  timeSec: number;
  /** Beat index (fractional for off-beats, e.g. 4.5). */
  beat: number;
  /** Lane index in `[0, lanes)`. */
  lane: number;
  /** MIDI note number for the synth pitch. */
  midi: number;
}

export interface Beatmap {
  bpm: number;
  beatsPerBar: number;
  lanes: number;
  offsetMs: number;
  durationSec: number;
  seed: number;
  notes: BeatmapNote[];
}

export interface GenerateBeatmapOptions {
  bpm?: number;
  lanes?: number;
  bars?: number;
  beatsPerBar?: number;
  /** Probability (0..1) of a note on a weak beat; strong beats always fire. */
  density?: number;
  offsetMs?: number;
  seed?: number;
}

export function generateBeatmap(opts?: GenerateBeatmapOptions): Beatmap;

export interface BeatmapJudgement {
  rating: 'perfect' | 'good' | 'miss';
  /** ms from the nearest note (null when no note was in range). */
  deltaMs: number | null;
  note?: BeatmapNote;
}

export interface BeatmapSynth {
  beatmap: Beatmap;
  start(): BeatmapSynth;
  stop(): void;
  /** Seconds since the chart's first note, from the real AudioContext clock. */
  audioTime(): number;
  judge(lane?: number | null, atSec?: number): BeatmapJudgement;
  upcoming(withinSec?: number): BeatmapNote[];
  isStarted(): boolean;
}

export interface CreateBeatmapSynthOptions extends GenerateBeatmapOptions {
  beatmap?: Beatmap;
  master?: number;
  perfectMs?: number;
  goodMs?: number;
}

export function createBeatmapSynth(opts?: CreateBeatmapSynthOptions): BeatmapSynth;
