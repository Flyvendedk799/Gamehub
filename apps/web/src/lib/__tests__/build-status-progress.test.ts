import { describe, expect, it } from 'vitest';
import { phaseOfProgressMessage } from '../build-status';

describe('phaseOfProgressMessage', () => {
  it('puts editing messages in Build and testing messages in Test', () => {
    expect(
      phaseOfProgressMessage('Found where this lives (src/combat.js). Rewriting it now…'),
    ).toBe(1);
    expect(phaseOfProgressMessage('Testing the game in a real browser: boot, controls…')).toBe(2);
    expect(phaseOfProgressMessage('One play check did not pass. Running it again…')).toBe(2);
    expect(phaseOfProgressMessage('Taking a look at a frame of the running game…')).toBe(2);
  });

  it('leaves unrelated text alone', () => {
    expect(
      phaseOfProgressMessage('Reading through the game to find where this belongs…'),
    ).toBeNull();
    expect(phaseOfProgressMessage('I think the camera is the problem.')).toBeNull();
  });
});

describe('draft_ready', () => {
  it('is accepted off the wire and moves the tracker to Test without ending the run', async () => {
    const { parseSseFrame } = await import('../api');
    const { deriveBuildStatus } = await import('../build-status');
    const frame = parseSseFrame(JSON.stringify({ type: 'draft_ready' }));
    expect(frame?.type).toBe('draft_ready');

    const status = deriveBuildStatus([
      {
        type: 'user_message',
        runId: 'r1',
        content: 'improve it',
        timestamp: '2026-10-24T10:00:00Z',
      },
      { type: 'draft_ready', runId: 'r1', timestamp: '2026-10-24T10:02:00Z' },
    ]);
    expect(status.phaseIndex).toBe(2);
    expect(status.done).toBe(false);
  });
});
