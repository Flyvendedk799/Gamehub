/**
 * Integration G — `estimateContextUsedPct` is the missing input to
 * `shouldPauseForContinuation`'s `context_threshold` rule. Approximates
 * pi-agent-core's re-replay-on-every-turn behaviour from cumulative
 * byte counters the runtime tracks, so the threshold can fire on real
 * conditions instead of staying at 0.
 *
 * Pure function tests — bytes in, fraction out, no IO.
 *
 * Note: as of the 2026-06 pricing refresh, Opus 4.6/4.7/4.8, Sonnet 4.6, and
 * Fable 5 all have a 1M standard context window. Haiku 4.5 (200k) is now the
 * canonical small-window reference used by these tests.
 */

import { describe, expect, it } from 'vitest';
import {
  type CumulativeContextBytes,
  MODEL_CONTEXT_WINDOWS,
  contextWindowFor,
  estimateContextUsedPct,
} from './pricing';

const zero: CumulativeContextBytes = {
  initialPromptBytes: 0,
  outputBytes: 0,
  toolResultBytes: 0,
};

describe('contextWindowFor (Integration G)', () => {
  it('returns the Haiku-4-5 window (200k) for the canonical id', () => {
    expect(contextWindowFor('claude-haiku-4-5')).toBe(200_000);
  });

  it('returns 1M for the now-1M-standard frontier models', () => {
    expect(contextWindowFor('claude-sonnet-4-6')).toBe(1_000_000);
    expect(contextWindowFor('claude-opus-4-8')).toBe(1_000_000);
    expect(contextWindowFor('claude-sonnet-4-6[1m]')).toBe(1_000_000);
    expect(contextWindowFor('claude-opus-4-7[1m]')).toBe(1_000_000);
  });

  it('falls back to 200k for unknown models', () => {
    expect(contextWindowFor('never-released-model')).toBe(200_000);
    expect(contextWindowFor('')).toBe(200_000);
    expect(contextWindowFor(null)).toBe(200_000);
    expect(contextWindowFor(undefined)).toBe(200_000);
  });

  it('the lookup table is frozen', () => {
    expect(() => {
      // biome-ignore lint/suspicious/noExplicitAny: deliberate mutation test
      (MODEL_CONTEXT_WINDOWS as any)['claude-haiku-4-5'] = 999;
    }).toThrow();
  });
});

describe('estimateContextUsedPct (Integration G)', () => {
  it('returns 0 for zero cumulative bytes', () => {
    expect(estimateContextUsedPct(zero, 'claude-haiku-4-5')).toBe(0);
  });

  it('200k tokens of input on a 200k window reads as 1.0', () => {
    // 200_000 tokens × 4 chars/token = 800_000 bytes
    expect(
      estimateContextUsedPct(
        { initialPromptBytes: 800_000, outputBytes: 0, toolResultBytes: 0 },
        'claude-haiku-4-5',
      ),
    ).toBeCloseTo(1, 4);
  });

  it('80k cumulative tokens on a 200k window reads as 0.4 — below the pause threshold', () => {
    // 80_000 × 4 = 320_000 bytes. Pause threshold is 0.8 — so 0.4 is well below.
    const pct = estimateContextUsedPct(
      { initialPromptBytes: 320_000, outputBytes: 0, toolResultBytes: 0 },
      'claude-haiku-4-5',
    );
    expect(pct).toBeCloseTo(0.4, 4);
    expect(pct).toBeLessThan(0.8);
  });

  it('160k cumulative tokens on a 200k window crosses the pause threshold (0.8)', () => {
    // 160_000 × 4 = 640_000 bytes
    const pct = estimateContextUsedPct(
      { initialPromptBytes: 640_000, outputBytes: 0, toolResultBytes: 0 },
      'claude-haiku-4-5',
    );
    expect(pct).toBeGreaterThanOrEqual(0.8);
  });

  it('sums all three byte sources', () => {
    const pct = estimateContextUsedPct(
      { initialPromptBytes: 200_000, outputBytes: 200_000, toolResultBytes: 200_000 },
      'claude-haiku-4-5',
    );
    // 600_000 bytes → 150_000 tokens / 200_000 window = 0.75
    expect(pct).toBeCloseTo(0.75, 4);
  });

  it('a 1M-context model has higher headroom than a 200k model for the same byte count', () => {
    const bytes = { initialPromptBytes: 800_000, outputBytes: 0, toolResultBytes: 0 };
    const haiku = estimateContextUsedPct(bytes, 'claude-haiku-4-5'); // 200k window
    const sonnet1m = estimateContextUsedPct(bytes, 'claude-sonnet-4-6'); // now 1M window
    expect(haiku).toBeGreaterThan(sonnet1m);
    expect(sonnet1m).toBeCloseTo(0.2, 4);
  });

  it('clamps at 1.5 even for impossibly large estimates (defensive)', () => {
    const pct = estimateContextUsedPct(
      { initialPromptBytes: 1_000_000_000, outputBytes: 0, toolResultBytes: 0 },
      'claude-haiku-4-5',
    );
    expect(pct).toBe(1.5);
  });

  it('rejects negative inputs (treated as zero)', () => {
    expect(
      estimateContextUsedPct(
        { initialPromptBytes: -100, outputBytes: -100, toolResultBytes: 0 },
        'claude-haiku-4-5',
      ),
    ).toBe(0);
  });

  it('FPS-run shape (mouf8wgh-nazlpq): real data → expected pct', () => {
    // Real run had 3.25M input tokens cumulative at end. On a 200k Haiku window
    // that's 16.25 → clamped to 1.5; even on a 1M window it's 3.25 → clamped.
    const FPS_INPUT_BYTES = 3_254_173 * 4; // 3.25M tokens
    const pctHaiku = estimateContextUsedPct(
      { initialPromptBytes: FPS_INPUT_BYTES, outputBytes: 0, toolResultBytes: 0 },
      'claude-haiku-4-5',
    );
    expect(pctHaiku).toBe(1.5); // clamped
    const pct1m = estimateContextUsedPct(
      { initialPromptBytes: FPS_INPUT_BYTES, outputBytes: 0, toolResultBytes: 0 },
      'claude-sonnet-4-6', // 1M window
    );
    expect(pct1m).toBeGreaterThan(1.0); // way over the 1M window
  });
});
