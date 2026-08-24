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
      agentStarts: 0,
      agentRestarts: 0,
      restartReestablishTokens: 0,
      restartReestablishShare: 0,
      restartSegmentTurns: [],
    });
  });
});

// ---------------------------------------------------------------------------
// BUILD_SPEED §6 — what a restart actually costs
// ---------------------------------------------------------------------------

describe('restart accounting — BUILD_SPEED §6', () => {
  const turn = (input: number, cacheRead: number, cacheWrite: number): AgentEvent =>
    ({
      type: 'turn_end',
      message: { usage: { input, output: 100, cacheRead, cacheWrite } },
    }) as unknown as AgentEvent;
  const start = (): AgentEvent => ({ type: 'agent_start' }) as unknown as AgentEvent;

  it('a single-segment run reports no restarts and no re-establish cost', () => {
    const agg = createRunSignalAggregator();
    agg.observe(start());
    agg.observe(turn(500, 8000, 0));
    agg.observe(turn(400, 9000, 0));
    const s = agg.snapshot();
    expect(s.agentStarts).toBe(1);
    expect(s.agentRestarts).toBe(0);
    expect(s.restartReestablishTokens).toBe(0);
    expect(s.restartReestablishShare).toBe(0);
    expect(s.restartSegmentTurns).toEqual([2]);
  });

  it('prices each restart at the fresh input + cache WRITE of its first turn', () => {
    const agg = createRunSignalAggregator();
    agg.observe(start());
    agg.observe(turn(500, 0, 10_000)); // run's own priming — not a restart cost
    agg.observe(turn(300, 10_000, 0));
    agg.observe(start()); // ← restart: the prefix has to be re-primed
    agg.observe(turn(700, 0, 12_000));
    agg.observe(turn(200, 12_000, 0));
    const s = agg.snapshot();
    expect(s.agentStarts).toBe(2);
    expect(s.agentRestarts).toBe(1);
    // 700 fresh input + 12_000 cache write, and nothing from the first segment.
    expect(s.restartReestablishTokens).toBe(12_700);
    expect(s.restartSegmentTurns).toEqual([2, 2]);
    // Share of total billed input across the run.
    const billed = 500 + 10_000 + 300 + 10_000 + 700 + 12_000 + 200 + 12_000;
    expect(s.restartReestablishShare).toBeCloseTo(12_700 / billed, 6);
  });

  it('counts three starts as two restarts (the run-3 shape)', () => {
    const agg = createRunSignalAggregator();
    for (let i = 0; i < 3; i += 1) {
      agg.observe(start());
      agg.observe(turn(100, 0, 5_000));
    }
    const s = agg.snapshot();
    expect(s.agentRestarts).toBe(2);
    expect(s.restartReestablishTokens).toBe(2 * 5_100);
  });

  it('tolerates a provider that streams turn_end without usage', () => {
    const agg = createRunSignalAggregator();
    agg.observe(start());
    agg.observe({ type: 'turn_end', message: {} } as unknown as AgentEvent);
    const s = agg.snapshot();
    expect(s.restartReestablishTokens).toBe(0);
    expect(s.restartSegmentTurns).toEqual([1]);
  });
});
