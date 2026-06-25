import { describe, expect, it } from 'vitest';
import {
  chatMessageToEvents,
  hydrateHistoryEvents,
  lastPreviewUrlFromHistory,
} from '../chat-hydration';
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

describe('hydrateHistoryEvents (dedup vs the streamed run)', () => {
  it('drops the chat-derived terminal for the streamed run (run_paused) so it is not doubled', () => {
    // A paused run we are re-attaching to: the live SSE stream replays its own
    // run_paused terminal, so the chat-derived one must be dropped — else two
    // paused cards (and two Resume affordances) render.
    const history: ChatHistoryMessage[] = [
      msg({ kind: 'user', payload: { text: 'build it', runId: 'r1' } }),
      msg({ kind: 'continuation_pending', payload: { runId: 'r1' } }),
    ];
    const events = hydrateHistoryEvents(history, 'r1');
    expect(events.map((e) => e.type)).toEqual(['user_message']);
    expect(events.some((e) => e.type === 'run_paused')).toBe(false);
  });

  it('drops the chat-derived run_complete for the streamed run', () => {
    const history: ChatHistoryMessage[] = [
      msg({ kind: 'user', payload: { text: 'go', runId: 'r2' } }),
      msg({ kind: 'artifact_delivered', payload: { runId: 'r2', previewUrl: '/p' } }),
    ];
    expect(hydrateHistoryEvents(history, 'r2').map((e) => e.type)).toEqual(['user_message']);
  });

  it('keeps terminals for OTHER runs (only the streamed run is deduped)', () => {
    const history: ChatHistoryMessage[] = [
      msg({ kind: 'continuation_pending', payload: { runId: 'old' } }),
      msg({ kind: 'continuation_pending', payload: { runId: 'current' } }),
    ];
    // Re-attaching to `current`: its terminal is deduped, the older run's stays.
    const events = hydrateHistoryEvents(history, 'current');
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('run_paused');
    if (events[0]?.type === 'run_paused') expect(events[0].runId).toBe('old');
  });

  it('keeps every row when nothing is being streamed (streamRunId null)', () => {
    const history: ChatHistoryMessage[] = [
      msg({ kind: 'user', payload: { text: 'a', runId: 'r3' } }),
      msg({ kind: 'artifact_delivered', payload: { runId: 'r3', previewUrl: '/p' } }),
    ];
    expect(hydrateHistoryEvents(history, null).map((e) => e.type)).toEqual([
      'user_message',
      'run_complete',
    ]);
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
