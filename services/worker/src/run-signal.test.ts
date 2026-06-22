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

  it('counts failed edits — REAL shape: str_replace_based_edit_tool + top-level isError', () => {
    const agg = createRunSignalAggregator();
    // The actual agent event: edit tool is `str_replace_based_edit_tool` and
    // isError is TOP-LEVEL on the event (this is what the old code missed entirely).
    const edit = (isError: boolean): AgentEvent =>
      ({
        type: 'tool_execution_end',
        toolName: 'str_replace_based_edit_tool',
        args: {},
        result: { content: [] },
        isError,
        toolCallId: 'c',
      }) as unknown as AgentEvent;
    agg.observe(edit(true));
    agg.observe(edit(false));
    agg.observe(edit(true));
    expect(agg.snapshot().strReplaceFailures).toBe(2);
  });

  it('counts failed edits — legacy fallback (result.isError on str_replace/text_editor)', () => {
    const agg = createRunSignalAggregator();
    agg.observe(end('str_replace', { isError: true }));
    agg.observe(end('str_replace', { isError: false }));
    agg.observe(end('text_editor', { isError: true }));
    expect(agg.snapshot().strReplaceFailures).toBe(2);
  });

  it('captures skills imported via import_skill (v3 P1 — primary via tool_execution_end)', () => {
    const agg = createRunSignalAggregator();
    // PRIMARY: end-event carries result.details.name.
    agg.observe(end('import_skill', { details: { name: 'phaser/wave-spawner.js' } }));
    // FALLBACK: start-event args.name (older shape).
    agg.observe(start('import_skill', { name: 'phaser/enemy-ai.js' }));
    agg.observe(end('import_skill', { details: { name: 'phaser/enemy-ai.js' } })); // dup
    const s = agg.snapshot();
    expect(s.skillsImported).toEqual(['phaser/enemy-ai.js', 'phaser/wave-spawner.js']);
    expect(s.skillsViewed).toEqual([]); // import is NOT a view
  });

  it('defaults are empty/false for a no-op run', () => {
    const s = createRunSignalAggregator().snapshot();
    expect(s).toEqual({
      toolCalls: {},
      toolCallTotal: 0,
      skillsViewed: [],
      skillsImported: [],
      invariantWarnings: [],
      contractAuthored: false,
      tweakSchemaDeclared: false,
      strReplaceFailures: 0,
    });
  });
});
