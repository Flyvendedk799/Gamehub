import type { GameQuality } from '@playforge/shared/game-quality';
import { describe, expect, it } from 'vitest';
import {
  type AgentTurn,
  buildTurns,
  currentLabel,
  fixIssuesPrompt,
  hasOpenIssues,
  workedFor,
} from '../run-turns';
import type { SseEvent } from '../types';

const clock = Date.parse('2026-10-24T10:00:00Z');
const at = (seconds: number) => new Date(clock + seconds * 1000).toISOString();

const user = (text: string, t = 0): SseEvent => ({
  type: 'user_message',
  runId: 'r1',
  content: text,
  timestamp: at(t),
});
const progress = (label: string, t: number, phase?: 'edit' | 'test'): SseEvent => ({
  type: 'progress',
  runId: 'r1',
  label,
  ...(phase !== undefined ? { phase } : {}),
  timestamp: at(t),
});
const summary = (text: string, t: number): SseEvent => ({
  type: 'summary',
  runId: 'r1',
  text,
  timestamp: at(t),
});
const complete = (t: number, quality: GameQuality | null = null): SseEvent => ({
  type: 'run_complete',
  runId: 'r1',
  snapshotPath: '',
  previewUrl: '/p',
  quality,
  timestamp: at(t),
});
const tool = (toolName: string, input: Record<string, unknown>, t: number): SseEvent => ({
  type: 'tool_use',
  runId: 'r1',
  toolName,
  status: 'start',
  input,
  // The stream normaliser lifts a written file's path onto the event.
  ...(typeof input['path'] === 'string' && input['command'] !== 'view'
    ? { path: input['path'] }
    : {}),
  timestamp: at(t),
});

const agent = (turns: ReturnType<typeof buildTurns>, index: number): AgentTurn => {
  const turn = turns[index];
  if (turn?.kind !== 'agent') throw new Error(`turn ${index} is not an agent turn`);
  return turn;
};

describe('buildTurns', () => {
  it('folds a finished fast edit into a user turn and one agent turn', () => {
    const turns = buildTurns([
      user('make movement better'),
      progress('Reading through your game', 1),
      progress('Editing combat.js', 4, 'edit'),
      progress('Testing it in a real browser', 40, 'test'),
      { type: 'draft_ready', runId: 'r1', timestamp: at(45) },
      summary('- Movement now feels responsive.', 100),
      complete(101),
    ]);
    expect(turns.map((t) => t.kind)).toEqual(['user', 'agent']);
    const a = agent(turns, 1);
    expect(a.status).toBe('done');
    expect(a.steps.map((s) => [s.label, s.state])).toEqual([
      ['Reading through your game', 'done'],
      ['Editing combat.js', 'done'],
      ['Testing it in a real browser', 'done'],
    ]);
    expect(a.summary).toBe('- Movement now feels responsive.');
    expect(a.previewUpdated).toBe(true);
    expect(workedFor(a)).toBe('1m 41s');
  });

  it('shows a run in progress as working, with the latest step active', () => {
    const turns = buildTurns(
      [
        user('improve combat'),
        progress('Reading through your game', 1),
        progress('Editing a.js', 5),
      ],
      { streaming: true },
    );
    const a = agent(turns, 1);
    expect(a.status).toBe('working');
    expect(a.steps.map((s) => s.state)).toEqual(['done', 'active']);
    expect(currentLabel(a)).toBe('Editing a.js');
  });

  it('treats an unfinished turn as over once nothing is streaming', () => {
    const turns = buildTurns([user('x'), progress('Editing a.js', 2)], { streaming: false });
    const a = agent(turns, 1);
    expect(a.status).toBe('done');
    expect(a.steps[0]?.state).toBe('done');
  });

  it('turns the agent-loop tools into human steps and folds repeats', () => {
    const turns = buildTurns(
      [
        user('build a game'),
        tool('declare_game_spec', {}, 1),
        tool('str_replace_based_edit_tool', { command: 'view', path: 'src/main.js' }, 2),
        tool('str_replace_based_edit_tool', { command: 'create', path: 'src/player.js' }, 3),
        tool('str_replace_based_edit_tool', { command: 'str_replace', path: 'src/player.js' }, 4),
        tool('playtest_game', {}, 5),
      ],
      { streaming: true },
    );
    const labels = agent(turns, 1).steps.map((s) => [s.label, s.count]);
    // The view is reading, not building; the two player edits are one step.
    expect(labels).toEqual([
      ['Deciding the design', 1],
      ['Writing the player', 2],
      ['Playing it to check', 1],
    ]);
  });

  it('keeps the agent narration as notes, never as the headline', () => {
    const turns = buildTurns(
      [
        user('x'),
        { type: 'text_delta', runId: 'r1', delta: 'I will check ', timestamp: at(1) },
        { type: 'text_delta', runId: 'r1', delta: 'the playbook.', timestamp: at(2) },
        progress('Testing it in a real browser', 3),
      ],
      { streaming: true },
    );
    const a = agent(turns, 1);
    expect(a.notes).toEqual(['I will check the playbook.']);
    expect(currentLabel(a)).toBe('Testing it in a real browser');
  });

  it('marks the active step failed when the run errors', () => {
    const turns = buildTurns([
      user('x'),
      progress('Editing a.js', 1),
      { type: 'run_error', runId: 'r1', error: 'boom', timestamp: at(3) },
    ]);
    const a = agent(turns, 1);
    expect(a.status).toBe('error');
    expect(a.error).toBe('boom');
    expect(a.steps[0]?.state).toBe('failed');
  });

  it('carries a pause and the question the agent asked', () => {
    const turns = buildTurns([
      user('x'),
      { type: 'run_paused', runId: 'r1', question: 'Which colour?', timestamp: at(3) },
    ]);
    const a = agent(turns, 1);
    expect(a.status).toBe('paused');
    expect(a.question).toBe('Which colour?');
  });

  it('reads a reloaded conversation: reply and delivery with no progress events', () => {
    const turns = buildTurns([
      user('make it faster'),
      summary('- It is faster now.', 5),
      complete(6),
      user('and louder', 60),
      summary('- Louder.', 65),
      complete(66),
    ]);
    expect(turns.map((t) => t.kind)).toEqual(['user', 'agent', 'user', 'agent']);
    expect(agent(turns, 1).summary).toBe('- It is faster now.');
    expect(agent(turns, 3).summary).toBe('- Louder.');
    expect(agent(turns, 1).steps).toEqual([]);
  });

  it('takes the changed files from the summary when the host wrote them (no tool events)', () => {
    const turns = buildTurns([
      user('x'),
      {
        type: 'summary',
        runId: 'r1',
        text: '- Done.',
        files: ['src/combat.js', 'src/hud.js'],
        timestamp: at(5),
      },
      complete(6),
    ]);
    expect(agent(turns, 1).files).toEqual(['src/combat.js', 'src/hud.js']);
  });

  it('lists the files a turn wrote, and only that turn', () => {
    const turns = buildTurns([
      user('a'),
      tool('str_replace_based_edit_tool', { command: 'create', path: 'src/a.js' }, 1),
      complete(2),
      user('b', 10),
      tool('str_replace_based_edit_tool', { command: 'create', path: 'src/b.js' }, 11),
      complete(12),
    ]);
    expect(agent(turns, 1).files).toEqual(['src/a.js']);
    expect(agent(turns, 3).files).toEqual(['src/b.js']);
  });
});

describe('turn helpers', () => {
  const quality = (status: GameQuality['status'], issues: string[]): GameQuality => ({
    schemaVersion: 1,
    filesHash: 'h',
    status,
    booted: true,
    behaviorPassed: status === 'verified',
    issues,
  });

  it('only reports open issues when a version shipped with failed checks', () => {
    const turns = buildTurns([
      user('x'),
      complete(1, quality('needs_fixes', ['opponent HP did NOT decrease'])),
    ]);
    expect(hasOpenIssues(agent(turns, 1))).toBe(true);
    const ok = buildTurns([user('x'), complete(1, quality('verified', []))]);
    expect(hasOpenIssues(agent(ok, 1))).toBe(false);
  });

  it('asks for exactly the flagged issues to be fixed', () => {
    const prompt = fixIssuesPrompt(['a', 'b']);
    expect(prompt).toContain('- a');
    expect(prompt).toContain('- b');
    expect(prompt).toContain('without changing anything else');
  });

  it('formats time worked, and omits it when it cannot be known', () => {
    const base = buildTurns([user('x', 0), progress('a', 0), complete(45)]);
    expect(workedFor(agent(base, 1))).toBe('45s');
    const none = buildTurns([
      user('x'),
      { type: 'run_complete', runId: 'r', snapshotPath: '', previewUrl: '', timestamp: 'bad' },
    ]);
    expect(workedFor(agent(none, 1))).toBeNull();
  });
});
