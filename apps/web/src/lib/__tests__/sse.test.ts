import { describe, expect, it } from 'vitest';
import {
  SSE_NAMED_TYPES,
  isTerminalSseEvent,
  parseSseFrame,
  reconnectDelay,
} from '../api';
import type { SseEvent } from '../types';

describe('parseSseFrame', () => {
  it('parses a well-formed named event', () => {
    const frame = JSON.stringify({
      type: 'text_delta',
      runId: 'r1',
      delta: 'hello',
      timestamp: '2026-01-01T00:00:00Z',
    });
    const parsed = parseSseFrame(frame);
    expect(parsed).not.toBeNull();
    expect(parsed?.type).toBe('text_delta');
  });

  it('returns null for empty input', () => {
    expect(parseSseFrame('')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseSseFrame('{not json')).toBeNull();
  });

  it('returns null for JSON that is not an object', () => {
    expect(parseSseFrame('42')).toBeNull();
    expect(parseSseFrame('"str"')).toBeNull();
    expect(parseSseFrame('null')).toBeNull();
  });

  it('returns null when type is missing or not a known event', () => {
    expect(parseSseFrame(JSON.stringify({ runId: 'r1' }))).toBeNull();
    expect(parseSseFrame(JSON.stringify({ type: 'bogus', runId: 'r1' }))).toBeNull();
  });

  it('rejects client-only synthetic kinds that never arrive over the wire', () => {
    // user_message is client-synthesized; the server never emits it as SSE.
    expect(parseSseFrame(JSON.stringify({ type: 'user_message', content: 'hi' }))).toBeNull();
  });

  it('accepts every server-emitted named type', () => {
    for (const type of SSE_NAMED_TYPES) {
      const parsed = parseSseFrame(JSON.stringify({ type, runId: 'r1' }));
      expect(parsed?.type).toBe(type);
    }
  });
});

describe('isTerminalSseEvent', () => {
  it('is true for run_complete and run_error only', () => {
    const complete: SseEvent = {
      type: 'run_complete',
      runId: 'r',
      snapshotPath: '',
      previewUrl: '',
      timestamp: 't',
    };
    const error: SseEvent = { type: 'run_error', runId: 'r', error: 'x', timestamp: 't' };
    const agentEnd: SseEvent = { type: 'agent_end', runId: 'r', timestamp: 't' };
    expect(isTerminalSseEvent(complete)).toBe(true);
    expect(isTerminalSseEvent(error)).toBe(true);
    // #34: agent_end is NOT terminal.
    expect(isTerminalSseEvent(agentEnd)).toBe(false);
  });
});

describe('reconnectDelay', () => {
  it('grows exponentially from 500ms', () => {
    expect(reconnectDelay(0)).toBe(500);
    expect(reconnectDelay(1)).toBe(1000);
    expect(reconnectDelay(2)).toBe(2000);
    expect(reconnectDelay(3)).toBe(4000);
  });

  it('caps at 16000ms', () => {
    expect(reconnectDelay(6)).toBe(16000);
    expect(reconnectDelay(20)).toBe(16000);
  });
});
