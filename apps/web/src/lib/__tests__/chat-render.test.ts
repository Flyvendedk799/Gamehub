import { describe, expect, it } from 'vitest';
import { buildRenderItems } from '../chat-render';
import type { SseEvent } from '../types';

function delta(d: string): SseEvent {
  return { type: 'text_delta', runId: 'r', delta: d, timestamp: 't' };
}

describe('buildRenderItems', () => {
  it('coalesces consecutive text_delta events into one text group', () => {
    const items = buildRenderItems([delta('Hel'), delta('lo '), delta('world')]);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({ kind: 'text', key: 'text-0', text: 'Hello world' });
  });

  it('gives the coalesced group a stable key based on its start index', () => {
    const tool: SseEvent = {
      type: 'tool_use',
      runId: 'r',
      toolName: 'edit',
      status: 'start',
      timestamp: 't',
    };
    const items = buildRenderItems([tool, delta('a'), delta('b')]);
    expect(items).toHaveLength(2);
    expect(items[0]?.kind).toBe('event');
    expect(items[1]).toEqual({ kind: 'text', key: 'text-1', text: 'ab' });
  });

  it('separates two text runs split by a non-text event', () => {
    const tool: SseEvent = {
      type: 'tool_result',
      runId: 'r',
      toolName: 'edit',
      success: true,
      timestamp: 't',
    };
    const items = buildRenderItems([delta('one'), tool, delta('two')]);
    expect(items.map((i) => i.kind)).toEqual(['text', 'event', 'text']);
    expect(items[0]).toMatchObject({ key: 'text-0', text: 'one' });
    expect(items[2]).toMatchObject({ key: 'text-2', text: 'two' });
  });

  it('passes non-text events through as event items with stable keys', () => {
    const user: SseEvent = { type: 'user_message', runId: 'r', content: 'hi', timestamp: 't' };
    const complete: SseEvent = {
      type: 'run_complete',
      runId: 'r',
      snapshotPath: '',
      previewUrl: '/p',
      timestamp: 't',
    };
    const items = buildRenderItems([user, complete]);
    expect(items).toEqual([
      { kind: 'event', key: 'ev-0', event: user },
      { kind: 'event', key: 'ev-1', event: complete },
    ]);
  });

  it('returns an empty list for no events', () => {
    expect(buildRenderItems([])).toEqual([]);
  });
});
