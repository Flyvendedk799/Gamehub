import { describe, expect, it } from 'vitest';
import { type RuntimeVerifyResult, toRuntimeVerifyVerdict } from './browser-jobs';

const base: RuntimeVerifyResult = { hasGameContract: true, fatalErrors: [], bootedIn: 120 };

describe('toRuntimeVerifyVerdict', () => {
  // Run 550cef11: the browser-worker measured audioPlays but this mapping dropped
  // it, so the done gate read every juiced game as MUTE.
  it('forwards audioPlays from the browser-worker result', () => {
    expect(toRuntimeVerifyVerdict({ ...base, juiceScore: 387, audioPlays: 2 })).toEqual({
      hasGameContract: true,
      fatalErrors: [],
      juiceScore: 387,
      audioPlays: 2,
    });
  });

  it('keeps a measured zero — a real mute game still reads as mute', () => {
    expect(toRuntimeVerifyVerdict({ ...base, audioPlays: 0 }).audioPlays).toBe(0);
  });

  it('omits fields an older browser-worker did not report', () => {
    const verdict = toRuntimeVerifyVerdict(base);
    expect('audioPlays' in verdict).toBe(false);
    expect('juiceScore' in verdict).toBe(false);
    expect('renderedNonBlank' in verdict).toBe(false);
  });
});
