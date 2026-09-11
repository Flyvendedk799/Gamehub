import type { AgentEvent } from '@playforge/agent-core';
import { describe, expect, it } from 'vitest';
import { createRunSignalAggregator } from './run-signal';

const doneEnd = (details: Record<string, unknown>): AgentEvent =>
  ({
    type: 'tool_execution_end',
    toolName: 'done',
    toolCallId: 'd',
    args: {},
    result: { content: [], details },
  }) as unknown as AgentEvent;

describe('run signal — done force-accept', () => {
  it('records a best-effort accept and what was still failing', () => {
    const agg = createRunSignalAggregator();
    agg.observe(doneEnd({ status: 'has_errors', errors: [] }));
    agg.observe(
      doneEnd({
        status: 'ok',
        forceAccepted: true,
        unresolvedSources: ['runtime', 'game.invariant.fatal.content-plan'],
      }),
    );
    const snap = agg.snapshot();
    expect(snap.doneForceAccepted).toBe(true);
    expect(snap.doneUnresolvedSources).toEqual(['runtime', 'game.invariant.fatal.content-plan']);
  });

  it('stays false for a clean accept', () => {
    const agg = createRunSignalAggregator();
    agg.observe(doneEnd({ status: 'ok', errors: [] }));
    expect(agg.snapshot().doneForceAccepted).toBe(false);
    expect(agg.snapshot().doneUnresolvedSources).toEqual([]);
  });
});
