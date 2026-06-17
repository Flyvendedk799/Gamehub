import { describe, expect, it } from 'vitest';
import {
  SSE_NAMED_TYPES,
  isTerminalSseEvent,
  parseSseFrame,
  parseSseFrames,
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

describe('parseSseFrames — raw agent frame integration (2.1)', () => {
  it('normalizes a raw tool_execution_start frame instead of dropping it', () => {
    const frame = JSON.stringify({
      type: 'tool_execution_start',
      toolName: 'str_replace_based_edit_tool',
      args: { command: 'create', path: 'index.html' },
      toolCallId: 'c1',
    });
    const out = parseSseFrames(frame, 'run-1');
    expect(out).toHaveLength(1);
    expect(out[0]?.type).toBe('tool_use');
    if (out[0]?.type === 'tool_use') {
      expect(out[0].runId).toBe('run-1');
      expect(out[0].label).toBe('writing index.html');
    }
  });

  it('fans out a declare_game_spec frame into tool_use + game_spec', () => {
    const frame = JSON.stringify({
      type: 'tool_execution_start',
      toolName: 'declare_game_spec',
      args: { genre: 'shooter', winCondition: 'clear waves' },
    });
    const out = parseSseFrames(frame, 'run-1');
    expect(out.map((e) => e.type)).toEqual(['tool_use', 'game_spec']);
  });

  it('passes an already-normalized frame through as a single event', () => {
    const frame = JSON.stringify({ type: 'run_complete', runId: 'r', previewUrl: '/p' });
    const out = parseSseFrames(frame, 'r');
    expect(out).toHaveLength(1);
    expect(out[0]?.type).toBe('run_complete');
  });

  it('returns [] for malformed / unknown frames (no silent vanish path)', () => {
    expect(parseSseFrames('{bad', 'r')).toEqual([]);
    expect(parseSseFrames(JSON.stringify({ type: 'bogus' }), 'r')).toEqual([]);
    expect(parseSseFrames('', 'r')).toEqual([]);
  });

  it('normalizes a bare run_paused frame (2.5)', () => {
    const out = parseSseFrames(JSON.stringify({ type: 'run_paused' }), 'run-1');
    expect(out).toHaveLength(1);
    expect(out[0]?.type).toBe('run_paused');
    if (out[0]?.type === 'run_paused') expect(out[0].runId).toBe('run-1');
  });
});

describe('isTerminalSseEvent', () => {
  it('is true for run_complete, run_error, and run_paused', () => {
    const complete: SseEvent = {
      type: 'run_complete',
      runId: 'r',
      snapshotPath: '',
      previewUrl: '',
      timestamp: 't',
    };
    const error: SseEvent = { type: 'run_error', runId: 'r', error: 'x', timestamp: 't' };
    const paused: SseEvent = { type: 'run_paused', runId: 'r', timestamp: 't' };
    const agentEnd: SseEvent = { type: 'agent_end', runId: 'r', timestamp: 't' };
    expect(isTerminalSseEvent(complete)).toBe(true);
    expect(isTerminalSseEvent(error)).toBe(true);
    // 2.5: run_paused stops the stream — the server closes it after pausing.
    expect(isTerminalSseEvent(paused)).toBe(true);
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
