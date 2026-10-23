import { describe, expect, it } from 'vitest';
import { withReplayTimestamp } from './replay-stamp';

const WHEN = new Date('2026-10-24T10:02:00Z');

describe('withReplayTimestamp', () => {
  it('stamps the frames the chat uses to time a turn with when they really happened', () => {
    for (const type of [
      'progress',
      'summary',
      'draft_ready',
      'run_complete',
      'run_error',
      'run_paused',
    ]) {
      expect(withReplayTimestamp({ type }, WHEN)).toEqual({
        type,
        timestamp: '2026-10-24T10:02:00.000Z',
      });
    }
  });

  it('keeps every other field, and a timestamp the frame already has', () => {
    expect(withReplayTimestamp({ type: 'progress', label: 'Editing a.js' }, WHEN)).toEqual({
      type: 'progress',
      label: 'Editing a.js',
      timestamp: '2026-10-24T10:02:00.000Z',
    });
    expect(withReplayTimestamp({ type: 'summary', text: 'x', timestamp: 'kept' }, WHEN)).toEqual({
      type: 'summary',
      text: 'x',
      timestamp: 'kept',
    });
  });

  it('leaves agent wire frames and non-objects untouched', () => {
    const wire = { type: 'tool_execution_start', toolName: 'list_files' };
    expect(withReplayTimestamp(wire, WHEN)).toBe(wire);
    expect(withReplayTimestamp(null, WHEN)).toBeNull();
    expect(withReplayTimestamp('text', WHEN)).toBe('text');
  });
});
