import type { AgentEvent } from '@playforge/agent-core';
import type { EventBus } from '@playforge/bus';
import { describe, expect, it } from 'vitest';
import { type PersistRunEventInput, RunEventRecorder, textDeltaOf } from './run-event-recorder';

function fakeBus(published: unknown[]): EventBus {
  return {
    publish: async (_channel, message) => {
      published.push(message);
    },
    subscribe: async () => () => {},
    close: async () => {},
  };
}

const td = (delta: string): AgentEvent =>
  ({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } }) as AgentEvent;
const tool = (toolName: string): AgentEvent =>
  ({ type: 'tool_execution_start', toolName, args: {}, toolCallId: 'c' }) as AgentEvent;

async function flush() {
  // let the fire-and-forget persist promises settle
  await new Promise((r) => setTimeout(r, 0));
}

describe('textDeltaOf', () => {
  it('extracts a non-empty assistant text delta, else null', () => {
    expect(textDeltaOf(td('hi'))).toBe('hi');
    expect(textDeltaOf(td(''))).toBeNull();
    expect(textDeltaOf(tool('playtest_game'))).toBeNull();
    expect(textDeltaOf({ type: 'message_update' })).toBeNull();
    expect(textDeltaOf(null)).toBeNull();
  });
});

describe('RunEventRecorder', () => {
  it('publishes every raw event live (deltas included) but coalesces text for persistence', async () => {
    const published: unknown[] = [];
    const persisted: PersistRunEventInput[] = [];
    const rec = new RunEventRecorder('r1', 'p1', fakeBus(published), (i) => {
      persisted.push(i);
    });

    rec.onAgentEvent(td('Hello '));
    rec.onAgentEvent(td('world'));
    rec.onAgentEvent(tool('playtest_game'));
    await rec.control({ type: 'run_complete' });
    await flush();

    // LIVE: every raw frame, including both deltas.
    expect(published).toHaveLength(4);
    expect(
      (published[0] as { assistantMessageEvent: { delta: string } }).assistantMessageEvent.delta,
    ).toBe('Hello ');

    // DURABLE: one coalesced text row, then the tool, then the terminal — seq 0,1,2.
    expect(persisted.map((p) => p.seq)).toEqual([0, 1, 2]);
    expect(textDeltaOf(persisted[0]?.event)).toBe('Hello world');
    expect((persisted[1]?.event as { type: string }).type).toBe('tool_execution_start');
    expect((persisted[2]?.event as { type: string }).type).toBe('run_complete');
    for (const p of persisted) {
      expect(p.runId).toBe('r1');
      expect(p.projectId).toBe('p1');
    }
  });

  it('flushes trailing buffered text on a terminal control frame', async () => {
    const published: unknown[] = [];
    const persisted: PersistRunEventInput[] = [];
    const rec = new RunEventRecorder('r2', 'p2', fakeBus(published), (i) => {
      persisted.push(i);
    });

    rec.onAgentEvent(td('final thoughts'));
    await rec.control({ type: 'run_error', error: 'boom' });
    await flush();

    expect(textDeltaOf(persisted[0]?.event)).toBe('final thoughts');
    expect((persisted[1]?.event as { type: string; error: string }).error).toBe('boom');
  });

  it('streams streaming/loop internals live but never persists them', async () => {
    const published: unknown[] = [];
    const persisted: PersistRunEventInput[] = [];
    const rec = new RunEventRecorder('r4', 'p4', fakeBus(published), (i) => {
      persisted.push(i);
    });

    // A non-text message_update SNAPSHOT (openai-completions shape) + turn markers.
    const snapshot = {
      type: 'message_update',
      message: { role: 'assistant', content: [] },
    } as unknown as AgentEvent;
    rec.onAgentEvent({ type: 'turn_start' } as AgentEvent);
    rec.onAgentEvent(snapshot);
    rec.onAgentEvent(snapshot);
    rec.onAgentEvent({ type: 'message_start' } as AgentEvent);
    rec.onAgentEvent(tool('playtest_game'));
    rec.onAgentEvent({ type: 'turn_end' } as AgentEvent);
    await flush();

    // All 6 frames stream live…
    expect(published).toHaveLength(6);
    // …but only the tool call is persisted (seq 0, no noise rows).
    expect(persisted.map((p) => (p.event as { type: string }).type)).toEqual([
      'tool_execution_start',
    ]);
    expect(persisted[0]?.seq).toBe(0);
  });

  it('still streams live when no persist sink is wired (no-DB dev)', async () => {
    const published: unknown[] = [];
    const rec = new RunEventRecorder('r3', 'p3', fakeBus(published));
    rec.onAgentEvent(tool('choose_engine'));
    await rec.control({ type: 'run_complete' });
    expect(published).toHaveLength(2);
  });
});
