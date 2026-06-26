import { describe, expect, it } from 'vitest';
import { BUILD_PHASES, deriveBuildStatus, formatElapsed } from '../build-status';
import type { SseEvent } from '../types';

const T = '2026-06-26T10:00:00.000Z';
// Loose builder so a test can spell out only the fields it cares about; the
// `type` discriminant is required, the rest ride along as the right event shape.
const ev = (e: { type: SseEvent['type'] } & Record<string, unknown>): SseEvent =>
  ({ runId: 'r1', timestamp: T, ...e }) as SseEvent;

describe('deriveBuildStatus', () => {
  it('starts in Design and reports the first event time', () => {
    const s = deriveBuildStatus([ev({ type: 'agent_start' })]);
    expect(s.phase).toBe('Design');
    expect(s.phaseIndex).toBe(0);
    expect(s.startedAt).toBe(Date.parse(T));
    expect(s.currentStep).toMatch(/Design/i);
  });

  it('advances to Build on the first file write and shows the tool label', () => {
    const s = deriveBuildStatus([
      ev({ type: 'agent_start' }),
      ev({
        type: 'tool_use',
        toolName: 'str_replace_based_edit_tool',
        status: 'start',
        label: 'writing src/main.js',
        path: 'src/main.js',
      }),
    ]);
    expect(s.phase).toBe('Build');
    expect(s.currentStep).toBe('writing src/main.js');
  });

  it('advances to Test on a verify tool, then Ready on run_complete', () => {
    const base = [
      ev({
        type: 'tool_use',
        toolName: 'str_replace_based_edit_tool',
        status: 'start',
        path: 'src/main.js',
      }),
      ev({ type: 'tool_use', toolName: 'playtest_game', status: 'start', label: 'playtesting' }),
    ];
    expect(deriveBuildStatus(base).phase).toBe('Test');
    expect(
      deriveBuildStatus([
        ...base,
        ev({ type: 'run_complete', previewUrl: '/x', snapshotPath: 's' }),
      ]).done,
    ).toBe(true);
  });

  it('phases never regress (monotonic) — a late edit after Test stays in Test', () => {
    const s = deriveBuildStatus([
      ev({ type: 'tool_use', toolName: 'playtest_game', status: 'start' }),
      ev({
        type: 'tool_use',
        toolName: 'str_replace_based_edit_tool',
        status: 'start',
        path: 'a.js',
      }),
    ]);
    expect(s.phaseIndex).toBe(2);
  });

  it('agent_end → Test ("finishing up") while the server boots/repairs', () => {
    const s = deriveBuildStatus([
      ev({
        type: 'tool_use',
        toolName: 'str_replace_based_edit_tool',
        status: 'start',
        path: 'a.js',
      }),
      ev({ type: 'agent_end' }),
    ]);
    expect(s.phaseIndex).toBe(2);
    expect(s.currentStep).toMatch(/finishing/i);
  });

  it('uses the agent narration sentence as the current step', () => {
    const s = deriveBuildStatus([
      ev({
        type: 'message_update',
        role: 'assistant',
        content: 'Setting the scene.\nAdding the player controller so it runs and jumps.',
      }),
    ]);
    expect(s.currentStep).toBe('Adding the player controller so it runs and jumps.');
  });

  it('declare_playtest_contract (declared up front) does NOT jump to Test — stays in Build', () => {
    const s = deriveBuildStatus([
      ev({ type: 'tool_use', toolName: 'declare_playtest_contract', status: 'start' }),
      ev({
        type: 'tool_use',
        toolName: 'str_replace_based_edit_tool',
        status: 'start',
        path: 'index.html',
        label: 'writing index.html',
      }),
    ]);
    expect(s.phase).toBe('Build');
    expect(s.currentStep).toBe('writing index.html');
  });

  it('exposes exactly four ordered phases', () => {
    expect(BUILD_PHASES).toEqual(['Design', 'Build', 'Test', 'Ready']);
  });
});

describe('formatElapsed', () => {
  it('formats m:ss and h:mm:ss', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(42_000)).toBe('0:42');
    expect(formatElapsed(75_000)).toBe('1:15');
    expect(formatElapsed(3_661_000)).toBe('1:01:01');
  });
});
