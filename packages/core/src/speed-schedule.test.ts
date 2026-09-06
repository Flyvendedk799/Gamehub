import { describe, expect, it } from 'vitest';
import { SPEED_BUDGETS, nextSpeedAction } from './speed-schedule.js';

describe('S10 speed schedule', () => {
  it('forces early playtest once the entry exists and a few tools have run', () => {
    const action = nextSpeedAction({
      toolCallsSoFar: 12,
      entryWritten: true,
      playtestRan: false,
    });
    expect(action.kind).toBe('force_early_playtest');
  });

  it('continues after a playtest has already run', () => {
    expect(
      nextSpeedAction({
        toolCallsSoFar: 40,
        entryWritten: true,
        playtestRan: true,
      }).kind,
    ).toBe('continue');
  });

  it('exposes arcade wall-clock budgets under 8 minutes P90', () => {
    expect(SPEED_BUDGETS.wallClockP90Ms).toBeLessThanOrEqual(8 * 60_000);
    expect(SPEED_BUDGETS.wallClockP50Ms).toBeLessThanOrEqual(4 * 60_000);
  });
});
