/**
 * S10 — build-speed scheduling.
 *
 * Boxer runs burned 16–25 minutes polishing before the first playtest. Force
 * an early validation tail: after N tool calls OR after the first durable
 * write to src/main.*, schedule boot+playtest before juice/polish.
 */

export interface SpeedScheduleInput {
  toolCallsSoFar: number;
  /** True once src/main.js (or engine entry) has been written/edited. */
  entryWritten: boolean;
  /** True once at least one playtest_game / runtime verify has run. */
  playtestRan: boolean;
  /** Soft ceiling before we *require* a playtest (default 24). */
  earlyPlaytestAfterTools?: number;
}

export type SpeedScheduleAction =
  | { kind: 'continue' }
  | { kind: 'force_early_playtest'; reason: string };

export function nextSpeedAction(input: SpeedScheduleInput): SpeedScheduleAction {
  if (input.playtestRan) return { kind: 'continue' };
  const ceiling = input.earlyPlaytestAfterTools ?? 24;
  if (input.entryWritten && input.toolCallsSoFar >= Math.min(12, ceiling)) {
    return {
      kind: 'force_early_playtest',
      reason: 'entry exists — run boot+playtest before further polish (S10)',
    };
  }
  if (input.toolCallsSoFar >= ceiling) {
    return {
      kind: 'force_early_playtest',
      reason: `tool-call ceiling ${ceiling} reached with no playtest (S10)`,
    };
  }
  return { kind: 'continue' };
}

/** Target budgets used by eval telemetry (arcade goldens). */
export const SPEED_BUDGETS = {
  tokenP90: 300_000,
  wallClockP50Ms: 4 * 60_000,
  wallClockP90Ms: 8 * 60_000,
} as const;
