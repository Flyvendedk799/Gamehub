import { describe, expect, it } from 'vitest';
import { calculateTokens, pruneContextAtomic } from '../src/engine/context.js';

describe('Context Pruning & Compaction (pruneContextAtomic)', () => {
  it('unconditionally preserves pinned indices 0 and 1 (system and initial user intent)', () => {
    const messages = [
      { role: 'system', content: 'You are an expert game engine builder.' },
      { role: 'user', content: 'Create a space shooter in Phaser.' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_1', name: 'choose_engine' }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok' }],
      },
      { role: 'assistant', content: 'Engine chosen.' },
      { role: 'user', content: 'Next step.' },
      { role: 'assistant', content: 'Working on sprites.' },
      { role: 'user', content: 'Looks good.' },
    ];

    const result = pruneContextAtomic(messages, { maxTokens: 10, preserveTailTurns: 2 });
    expect(result.messages[0]).toEqual({
      role: 'system',
      content: 'You are an expert game engine builder.',
    });
    expect(result.messages[1]).toEqual({
      role: 'user',
      content: 'Create a space shooter in Phaser.',
    });
  });

  it('preserves the last preserveTailTurns turns by default (default 4)', () => {
    const messages = [
      { role: 'system', content: 'Sys' },
      { role: 'user', content: 'Init' },
      // Candidate pool (index 2-3)
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'c1', name: 'set_todos' }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'done' }],
      },
      // Tail pool (last 4: index 4, 5, 6, 7)
      { role: 'assistant', content: 'Step 1 complete' },
      { role: 'user', content: 'Continue' },
      { role: 'assistant', content: 'Step 2 complete' },
      { role: 'user', content: 'Ship it' },
    ];

    const result = pruneContextAtomic(messages);
    expect(result.messages).toHaveLength(7); // 2 pinned + 1 summary (c1 compacted) + 4 tail
    expect(result.messages[2]).toEqual({
      role: 'system',
      content: '[Summary: Executed 1 tool call(s) including set_todos]',
    });
    // Tail preserved
    expect(result.messages[3]).toEqual({ role: 'assistant', content: 'Step 1 complete' });
    expect(result.messages[4]).toEqual({ role: 'user', content: 'Continue' });
    expect(result.messages[5]).toEqual({ role: 'assistant', content: 'Step 2 complete' });
    expect(result.messages[6]).toEqual({ role: 'user', content: 'Ship it' });
  });

  it('calculates tokens using tokenDensityFactor (default 1.35)', () => {
    const messages = [{ role: 'user', content: 'Hello world' }];
    const defaultTokens = calculateTokens(messages);
    const customTokens = calculateTokens(messages, 2.0);

    expect(defaultTokens).toBeGreaterThan(0);
    expect(customTokens).toBeLessThanOrEqual(defaultTokens);
  });

  it('extracts thinking blocks into structured payload records and strips them from messages', () => {
    const messages = [
      { role: 'system', content: 'Sys' },
      { role: 'user', content: 'Build game' },
      {
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: 'I need to choose Phaser 3.80+ for this.',
            signature: 'sig_123',
          },
          { type: 'text', text: 'Selecting Phaser 3' },
        ],
      },
      {
        role: 'assistant',
        thinking: 'Planning entity architecture...',
        thinkingSignature: 'sig_456',
        content: [{ type: 'text', text: 'Entities setup' }],
      },
    ];

    const result = pruneContextAtomic(messages);
    expect(result.extractedThinkingBlocks).toHaveLength(2);
    expect(result.extractedThinkingBlocks[0]).toEqual({
      turnIndex: 2,
      signature: 'sig_123',
      thinking: 'I need to choose Phaser 3.80+ for this.',
    });
    expect(result.extractedThinkingBlocks[1]).toEqual({
      turnIndex: 3,
      signature: 'sig_456',
      thinking: 'Planning entity architecture...',
    });

    // Check stripped from messages
    const assistantMsg = result.messages[2];
    expect(assistantMsg.content).toEqual([{ type: 'text', text: 'Selecting Phaser 3' }]);
    expect(result.messages[3].thinking).toBeUndefined();
  });

  it('atomically compacts candidate tool invocations and purges corresponding tool results', () => {
    const messages = [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'User goal' },
      // Candidate assistant tool call
      {
        role: 'assistant',
        tool_calls: [
          { id: 'call_edit_1', function: { name: 'text_editor' } },
          { id: 'call_edit_2', function: { name: 'set_todos' } },
        ],
      },
      // Candidate tool results
      {
        role: 'tool',
        tool_call_id: 'call_edit_1',
        content: 'File updated successfully',
      },
      {
        role: 'tool',
        tool_call_id: 'call_edit_2',
        content: 'Todos saved',
      },
      // Tail
      { role: 'assistant', content: 'Next action' },
      { role: 'user', content: 'Looks great' },
    ];

    const result = pruneContextAtomic(messages, { preserveTailTurns: 2 });
    // Candidate tool calls replaced with summary
    expect(result.messages[2]).toEqual({
      role: 'system',
      content: '[Summary: Executed 2 tool call(s) including text_editor, set_todos]',
    });
    // Matching tool result messages were purged
    expect(result.messages.find((m) => m.tool_call_id === 'call_edit_1')).toBeUndefined();
    expect(result.messages.find((m) => m.tool_call_id === 'call_edit_2')).toBeUndefined();
    // Tail preserved
    expect(result.messages[3]).toEqual({ role: 'assistant', content: 'Next action' });
    expect(result.messages[4]).toEqual({ role: 'user', content: 'Looks great' });
  });

  it('purges orphaned tool results in tail whose invocations were pruned in candidate pool', () => {
    const messages = [
      { role: 'system', content: 'System' },
      { role: 'user', content: 'Prompt' },
      // Candidate
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_x', name: 'choose_engine' }],
      },
      // Tail containing tool_result for call_x
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_x', content: 'engine set' }],
      },
      { role: 'assistant', content: 'Tail 1' },
      { role: 'user', content: 'Tail 2' },
      { role: 'assistant', content: 'Tail 3' },
    ];

    const result = pruneContextAtomic(messages, { preserveTailTurns: 4 });
    const orphanResult = result.messages.find((m) =>
      Array.isArray(m.content) && m.content.some((b: any) => b.tool_use_id === 'call_x'),
    );
    expect(orphanResult).toBeUndefined();
  });
});
