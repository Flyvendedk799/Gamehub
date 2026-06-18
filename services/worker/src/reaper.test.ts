/**
 * Stuck-run reaper (4.1) — unit tests for the PURE selection decisions.
 *
 * The reaper's "which runs to reap" logic is split into two pure functions so
 * it's testable without a live Postgres/Redis:
 *   - selectRunsToReap   — staleness + non-terminal status (necessary, not
 *                          sufficient: a slow-but-alive job looks stale too).
 *   - shouldReapStaleRun — the BullMQ cross-check (job gone/failed ⇒ reap;
 *                          still active/waiting ⇒ leave alone).
 *
 * We also model the refund step here to prove the EXACTLY-ONCE property the
 * real reaper relies on (idempotent insert keyed on runId via the partial
 * unique 'credit_ledger_refund_key' + onConflictDoNothing).
 */
// Importing main.ts must not boot Redis or require DATABASE_URL — the
// entrypoint's autostart is guarded on VITEST (set by the test runner) and on
// WORKER_NO_AUTOSTART for any other importer.
import { describe, expect, it } from 'vitest';
import { type ReapCandidate, selectRunsToReap, shouldReapStaleRun } from './main';

const STUCK_AFTER_MS = 30 * 60 * 1000;
const NOW = 1_000_000_000_000;

function run(
  partial: Partial<ReapCandidate> & Pick<ReapCandidate, 'id' | 'status' | 'lastTouchedMs'>,
): ReapCandidate {
  return { userId: 'user_1', ...partial };
}

describe('selectRunsToReap (pure)', () => {
  it('selects a queued/running run not touched within the staleness window', () => {
    const stale = run({
      id: 'r_stale',
      status: 'running',
      lastTouchedMs: NOW - STUCK_AFTER_MS - 1,
    });
    const selected = selectRunsToReap([stale], { nowMs: NOW, stuckAfterMs: STUCK_AFTER_MS });
    expect(selected.map((r) => r.id)).toEqual(['r_stale']);
  });

  it('does NOT select a recent (healthy) run', () => {
    const recent = run({ id: 'r_recent', status: 'running', lastTouchedMs: NOW - 1_000 });
    expect(selectRunsToReap([recent], { nowMs: NOW, stuckAfterMs: STUCK_AFTER_MS })).toEqual([]);
  });

  it('does NOT select runs already in a terminal state, however old', () => {
    const old = NOW - STUCK_AFTER_MS - 99_999;
    const terminal: ReapCandidate[] = [
      run({ id: 'c', status: 'completed', lastTouchedMs: old }),
      run({ id: 'f', status: 'failed', lastTouchedMs: old }),
      run({ id: 'p', status: 'paused', lastTouchedMs: old }),
      run({ id: 'x', status: 'canceled', lastTouchedMs: old }),
    ];
    expect(selectRunsToReap(terminal, { nowMs: NOW, stuckAfterMs: STUCK_AFTER_MS })).toEqual([]);
  });

  it('selects only the stale ones from a mixed batch', () => {
    const old = NOW - STUCK_AFTER_MS - 1;
    const batch: ReapCandidate[] = [
      run({ id: 'queued_stale', status: 'queued', lastTouchedMs: old }),
      run({ id: 'running_stale', status: 'running', lastTouchedMs: old }),
      run({ id: 'running_fresh', status: 'running', lastTouchedMs: NOW - 5_000 }),
    ];
    expect(
      selectRunsToReap(batch, { nowMs: NOW, stuckAfterMs: STUCK_AFTER_MS }).map((r) => r.id),
    ).toEqual(['queued_stale', 'running_stale']);
  });
});

describe('shouldReapStaleRun (pure BullMQ cross-check)', () => {
  it('reaps when the job is gone (null) or failed/completed but the run never transitioned', () => {
    expect(shouldReapStaleRun(null)).toBe(true);
    expect(shouldReapStaleRun('failed')).toBe(true);
    expect(shouldReapStaleRun('completed')).toBe(true);
  });

  it('does NOT reap a still-alive job', () => {
    expect(shouldReapStaleRun('active')).toBe(false);
    expect(shouldReapStaleRun('waiting')).toBe(false);
    expect(shouldReapStaleRun('delayed')).toBe(false);
    expect(shouldReapStaleRun('prioritized')).toBe(false);
    expect(shouldReapStaleRun('paused')).toBe(false);
  });
});

describe('reap end-to-end decision: stale + dead job ⇒ reap + refund once', () => {
  // Models the idempotent ledger: a refund row is keyed on runId, so a second
  // insert (a re-sweep, or the worker.on('failed') handler also firing) is a
  // no-op — exactly the onConflictDoNothing + 'credit_ledger_refund_key' guard.
  function makeLedger() {
    const refundRunIds = new Set<string>();
    let creditsRefunded = 0;
    return {
      refundOnce(runId: string, credits: number): void {
        if (refundRunIds.has(runId)) return; // onConflictDoNothing
        refundRunIds.add(runId);
        creditsRefunded += credits;
      },
      get total() {
        return creditsRefunded;
      },
    };
  }

  it('a run past threshold whose job is gone is reaped and refunded EXACTLY once', () => {
    const ledger = makeLedger();
    const stale = run({ id: 'r1', status: 'running', lastTouchedMs: NOW - STUCK_AFTER_MS - 1 });

    const candidates = selectRunsToReap([stale], { nowMs: NOW, stuckAfterMs: STUCK_AFTER_MS });
    expect(candidates).toHaveLength(1);

    // Job gone ⇒ reap.
    for (const c of candidates) {
      if (shouldReapStaleRun(null)) ledger.refundOnce(c.id, 10);
    }
    // A second sweep (run still selected before the status UPDATE commits)
    // must not double-refund.
    for (const c of candidates) {
      if (shouldReapStaleRun(null)) ledger.refundOnce(c.id, 10);
    }
    expect(ledger.total).toBe(10);
  });

  it('a recent run, or a stale run with a live job, is NOT reaped or refunded', () => {
    const ledger = makeLedger();
    const recent = run({ id: 'r_recent', status: 'running', lastTouchedMs: NOW - 1_000 });
    const staleButAlive = run({
      id: 'r_alive',
      status: 'running',
      lastTouchedMs: NOW - STUCK_AFTER_MS - 1,
    });

    for (const c of selectRunsToReap([recent], { nowMs: NOW, stuckAfterMs: STUCK_AFTER_MS })) {
      ledger.refundOnce(c.id, 10);
    }
    for (const c of selectRunsToReap([staleButAlive], {
      nowMs: NOW,
      stuckAfterMs: STUCK_AFTER_MS,
    })) {
      if (shouldReapStaleRun('active')) ledger.refundOnce(c.id, 10);
    }
    expect(ledger.total).toBe(0);
  });
});
