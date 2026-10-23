import { describe, expect, it } from 'vitest';
import { parseSseFrames } from '../api';
import { deriveBuildStatus } from '../build-status';
import { chatMessageToEvents, hydrateHistoryEvents } from '../chat-hydration';
import { buildTurns } from '../run-turns';
import type { ChatHistoryMessage, SseEvent } from '../types';

function row(
  partial: Partial<ChatHistoryMessage> & Pick<ChatHistoryMessage, 'kind' | 'payload'>,
): ChatHistoryMessage {
  return { id: 1, projectId: 'p', seq: 0, createdAt: '2026-10-24T10:00:00Z', ...partial };
}

describe('the agent reply in saved history', () => {
  it('comes back as a summary event, with the files it changed', () => {
    const events = chatMessageToEvents(
      row({
        kind: 'assistant_text',
        payload: { runId: 'r1', text: '- Faster now.', files: ['src/main.js', 7, 'src/hud.js'] },
      }),
    );
    expect(events).toEqual([
      {
        type: 'summary',
        runId: 'r1',
        text: '- Faster now.',
        timestamp: '2026-10-24T10:00:00Z',
        files: ['src/main.js', 'src/hud.js'],
      },
    ]);
  });

  it('is ignored when empty or malformed', () => {
    expect(
      chatMessageToEvents(row({ kind: 'assistant_text', payload: { runId: 'r1', text: '  ' } })),
    ).toEqual([]);
    expect(chatMessageToEvents(row({ kind: 'assistant_text', payload: null }))).toEqual([]);
  });

  it('is skipped for the run being streamed live, which replays its own summary', () => {
    const messages = [
      row({ kind: 'user', payload: { text: 'go', runId: 'r1' }, seq: 0 }),
      row({ kind: 'assistant_text', payload: { runId: 'r1', text: '- Done.' }, seq: 1 }),
    ];
    expect(hydrateHistoryEvents(messages, 'r1').map((e) => e.type)).toEqual(['user_message']);
    expect(hydrateHistoryEvents(messages, null).map((e) => e.type)).toEqual([
      'user_message',
      'summary',
    ]);
  });

  it('turns a whole saved exchange into one user turn and one agent reply', () => {
    const events = hydrateHistoryEvents(
      [
        row({ kind: 'user', payload: { text: 'make combat better', runId: 'r1' }, seq: 0 }),
        row({ kind: 'assistant_text', payload: { runId: 'r1', text: '- Better.' }, seq: 1 }),
        row({
          kind: 'artifact_delivered',
          payload: { runId: 'r1', previewUrl: '/p', quality: null },
          seq: 2,
        }),
      ],
      null,
    );
    const turns = buildTurns(events);
    expect(turns.map((t) => t.kind)).toEqual(['user', 'agent']);
    expect(turns[1]).toMatchObject({ kind: 'agent', status: 'done', summary: '- Better.' });
  });
});

describe('frames relayed from the worker', () => {
  it('get the run id and a time filled in, so the chat can order and time them', () => {
    const [progress] = parseSseFrames(
      JSON.stringify({ type: 'progress', label: 'Editing a.js' }),
      'run-9',
    );
    expect(progress).toMatchObject({ type: 'progress', runId: 'run-9', label: 'Editing a.js' });
    expect(Number.isFinite(Date.parse((progress as { timestamp: string }).timestamp))).toBe(true);
  });

  it('keep the ones they already carry', () => {
    const [summary] = parseSseFrames(
      JSON.stringify({
        type: 'summary',
        text: 'ok then',
        runId: 'mine',
        timestamp: '2026-10-24T09:00:00Z',
      }),
      'run-9',
    );
    expect(summary).toMatchObject({ runId: 'mine', timestamp: '2026-10-24T09:00:00Z' });
  });
});

describe('build status from structured progress', () => {
  const ev = (e: Partial<SseEvent> & { type: SseEvent['type'] }): SseEvent =>
    ({ runId: 'r', timestamp: '2026-10-24T10:00:00Z', ...e }) as SseEvent;

  it('shows the latest step label and moves the phase with it', () => {
    const status = deriveBuildStatus([
      ev({ type: 'progress', label: 'Reading through your game', phase: 'understand' } as never),
      ev({ type: 'progress', label: 'Editing combat.js', phase: 'edit' } as never),
      ev({ type: 'progress', label: 'Testing it in a real browser', phase: 'test' } as never),
    ]);
    expect(status.currentStep).toBe('Testing it in a real browser');
    expect(status.phaseIndex).toBe(2);
  });

  it('never moves a phase backwards when an earlier-phase step arrives late', () => {
    const status = deriveBuildStatus([
      ev({ type: 'progress', label: 'Testing it in a real browser', phase: 'test' } as never),
      ev({ type: 'progress', label: 'Editing combat.js', phase: 'edit' } as never),
    ]);
    expect(status.phaseIndex).toBe(2);
  });
});
