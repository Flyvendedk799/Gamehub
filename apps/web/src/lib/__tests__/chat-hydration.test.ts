import { describe, expect, it } from 'vitest';
import { chatMessageToEvents, lastPreviewUrlFromHistory } from '../chat-hydration';
import type { ChatHistoryMessage } from '../types';

function msg(
  partial: Partial<ChatHistoryMessage> & Pick<ChatHistoryMessage, 'kind' | 'payload'>,
): ChatHistoryMessage {
  return {
    id: 1,
    projectId: 'p',
    seq: 0,
    createdAt: '2026-01-01T00:00:00Z',
    ...partial,
  };
}

describe('chatMessageToEvents', () => {
  it('hydrates a user row into a real user_message event (no `> ` hack)', () => {
    const events = chatMessageToEvents(
      msg({ kind: 'user', payload: { text: 'make a platformer', runId: 'r1' } }),
    );
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe('user_message');
    if (ev.type === 'user_message') {
      expect(ev.content).toBe('make a platformer');
      expect(ev.content).not.toMatch(/^>/);
      expect(ev.runId).toBe('r1');
    }
  });

  it('hydrates an artifact_delivered row into run_complete', () => {
    const events = chatMessageToEvents(
      msg({
        kind: 'artifact_delivered',
        payload: { runId: 'r2', previewUrl: '/v1/runs/r2/preview/' },
      }),
    );
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe('run_complete');
    if (ev.type === 'run_complete') {
      expect(ev.previewUrl).toBe('/v1/runs/r2/preview/');
    }
  });

  it('tolerates a null/empty payload', () => {
    const events = chatMessageToEvents(msg({ kind: 'user', payload: null }));
    expect(events[0]?.type).toBe('user_message');
    if (events[0]?.type === 'user_message') expect(events[0].content).toBe('');
  });

  it('hydrates a continuation_pending row into run_paused so Resume reappears on reload (2.5)', () => {
    const events = chatMessageToEvents(
      msg({ kind: 'continuation_pending', payload: { runId: 'r3', manifestKey: 'm1' } }),
    );
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe('run_paused');
    if (ev.type === 'run_paused') expect(ev.runId).toBe('r3');
  });

  it('ignores unknown kinds', () => {
    expect(chatMessageToEvents(msg({ kind: 'something_else', payload: {} }))).toEqual([]);
  });
});

describe('lastPreviewUrlFromHistory', () => {
  it('returns the last delivered preview url', () => {
    const history: ChatHistoryMessage[] = [
      msg({ kind: 'user', payload: { text: 'a' } }),
      msg({ kind: 'artifact_delivered', payload: { previewUrl: '/first' } }),
      msg({ kind: 'user', payload: { text: 'b' } }),
      msg({ kind: 'artifact_delivered', payload: { previewUrl: '/second' } }),
    ];
    expect(lastPreviewUrlFromHistory(history)).toBe('/second');
  });

  it('returns null when there are no artifacts', () => {
    expect(lastPreviewUrlFromHistory([msg({ kind: 'user', payload: { text: 'a' } })])).toBeNull();
  });
});
