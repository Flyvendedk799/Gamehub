import type { AgentEvent } from '@playforge/agent-core';
import { describe, expect, it } from 'vitest';
import { createRunSignalAggregator } from './run-signal';

const start = (toolName: string, args: Record<string, unknown> = {}): AgentEvent =>
  ({ type: 'tool_execution_start', toolName, args, toolCallId: 'c' }) as unknown as AgentEvent;
const end = (toolName: string, result: unknown): AgentEvent =>
  ({
    type: 'tool_execution_end',
    toolName,
    args: {},
    result,
    toolCallId: 'c',
  }) as unknown as AgentEvent;

describe('createRunSignalAggregator', () => {
  it('tallies a tool histogram + total', () => {
    const agg = createRunSignalAggregator();
    agg.observe(start('text_editor'));
    agg.observe(start('text_editor'));
    agg.observe(start('verify_artifact'));
    const s = agg.snapshot();
    expect(s.toolCalls).toEqual({ text_editor: 2, verify_artifact: 1 });
    expect(s.toolCallTotal).toBe(3);
  });

  it('captures skills opened via view_game_feel', () => {
    const agg = createRunSignalAggregator();
    agg.observe(start('view_game_feel', { name: 'phaser/wave-spawner.js' }));
    agg.observe(start('view_game_feel', { name: 'phaser/enemy-ai.js' }));
    agg.observe(start('view_game_feel', { name: 'phaser/wave-spawner.js' })); // dup
    expect(agg.snapshot().skillsViewed).toEqual(['phaser/enemy-ai.js', 'phaser/wave-spawner.js']);
  });

  it('records contract + tweak-schema authoring (the novelty path)', () => {
    const agg = createRunSignalAggregator();
    agg.observe(start('declare_playtest_contract', { checks: [] }));
    agg.observe(start('declare_tweak_schema', {}));
    const s = agg.snapshot();
    expect(s.contractAuthored).toBe(true);
    expect(s.tweakSchemaDeclared).toBe(true);
  });

  it('keeps the FINAL assert_game_invariants warnings', () => {
    const agg = createRunSignalAggregator();
    agg.observe(
      end('assert_game_invariants', { details: { issues: [{ invariant: 'feedback' }] } }),
    );
    // a later pass after a fix — only escalation remains
    agg.observe(
      end('assert_game_invariants', { details: { issues: [{ invariant: 'escalation' }] } }),
    );
    expect(agg.snapshot().invariantWarnings).toEqual(['escalation']);
  });

  it('counts failed edits (str_replace thrash)', () => {
    const agg = createRunSignalAggregator();
    agg.observe(end('str_replace', { isError: true }));
    agg.observe(end('str_replace', { isError: false }));
    agg.observe(end('text_editor', { isError: true }));
    expect(agg.snapshot().strReplaceFailures).toBe(2);
  });

  it('defaults are empty/false for a no-op run', () => {
    const s = createRunSignalAggregator().snapshot();
    expect(s).toEqual({
      toolCalls: {},
      toolCallTotal: 0,
      skillsViewed: [],
      invariantWarnings: [],
      contractAuthored: false,
      tweakSchemaDeclared: false,
      strReplaceFailures: 0,
    });
  });
});
