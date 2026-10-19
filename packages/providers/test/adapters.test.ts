import { describe, expect, it } from 'vitest';
import {
  DemuxingToolAccumulator,
  type RawToolCallChunk,
  coalesceAnthropicMessages,
} from '../src/index.js';

describe('Anthropic Adapter Turn Coalescing (coalesceAnthropicMessages)', () => {
  it('extracts system messages into top-level system parameter', () => {
    const input = [
      { role: 'system', content: 'System instruction 1' },
      { role: 'user', content: 'Hello' },
      { role: 'system', content: 'System instruction 2' },
      { role: 'assistant', content: 'Hi there' },
    ];

    const result = coalesceAnthropicMessages(input);
    expect(result.system).toBe('System instruction 1\n\nSystem instruction 2');
    expect(result.every((m) => m.role !== 'system')).toBe(true);
  });

  it('coalesces multiple consecutive tool results into a single user turn with tool_result blocks', () => {
    const input = [
      { role: 'user', content: 'Run tools' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call_1', name: 'tool_a', input: {} },
          { type: 'tool_use', id: 'call_2', name: 'tool_b', input: {} },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'Result A' },
      { role: 'tool', tool_call_id: 'call_2', content: 'Result B' },
    ];

    const result = coalesceAnthropicMessages(input);
    expect(result).toHaveLength(3); // user -> assistant -> user (coalesced tool results)
    expect(result[0]?.role).toBe('user');
    expect(result[1]?.role).toBe('assistant');
    expect(result[2]?.role).toBe('user');

    const lastTurnBlocks = result[2]?.content ?? [];
    expect(lastTurnBlocks).toHaveLength(2);
    expect(lastTurnBlocks[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'call_1',
      content: 'Result A',
    });
    expect(lastTurnBlocks[1]).toEqual({
      type: 'tool_result',
      tool_use_id: 'call_2',
      content: 'Result B',
    });
  });

  it('prepends a user turn if the first message is assistant', () => {
    const input = [{ role: 'assistant', content: 'Greetings mortal.' }];

    const result = coalesceAnthropicMessages(input);
    expect(result[0]?.role).toBe('user');
    expect(result[1]?.role).toBe('assistant');
  });

  it('normalizes OpenAI-style tool_calls into Anthropic tool_use blocks', () => {
    const input = [
      { role: 'user', content: 'Create a button' },
      {
        role: 'assistant',
        tool_calls: [
          {
            id: 'call_edit',
            type: 'function',
            function: {
              name: 'text_editor',
              arguments: JSON.stringify({ command: 'create', path: 'index.html' }),
            },
          },
        ],
      },
    ];

    const result = coalesceAnthropicMessages(input);
    expect(result[1]?.content[0]).toEqual({
      type: 'tool_use',
      id: 'call_edit',
      name: 'text_editor',
      input: { command: 'create', path: 'index.html' },
    });
  });
});

describe('OpenAI Parallel Streaming Tool Demuxing (DemuxingToolAccumulator)', () => {
  it('correctly demuxes interleaved parallel tool call chunks without cross-contamination', () => {
    const accumulator = new DemuxingToolAccumulator();

    // Stream interleaves chunks for tool 0 (text_editor) and tool 1 (set_todos)
    const chunks: RawToolCallChunk[] = [
      { index: 0, id: 'call_0', type: 'function', function: { name: 'text_editor' } },
      { index: 1, id: 'call_1', type: 'function', function: { name: 'set_todos' } },
      { index: 0, function: { arguments: '{"command":' } },
      { index: 1, function: { arguments: '{"todos":' } },
      { index: 0, function: { arguments: '"create",' } },
      { index: 1, function: { arguments: '["task1"]}' } },
      { index: 0, function: { arguments: '"path":"main.js"}' } },
    ];

    for (const chunk of chunks) {
      accumulator.feedChunk(chunk);
    }

    const finalized = accumulator.finalize();
    expect(finalized).toHaveLength(2);

    expect(finalized[0]).toEqual({
      index: 0,
      id: 'call_0',
      type: 'function',
      function: {
        name: 'text_editor',
        arguments: '{"command":"create","path":"main.js"}',
      },
    });

    expect(finalized[1]).toEqual({
      index: 1,
      id: 'call_1',
      type: 'function',
      function: {
        name: 'set_todos',
        arguments: '{"todos":["task1"]}',
      },
    });

    // Test JSON parsability
    expect(JSON.parse(finalized[0]!.function.arguments)).toEqual({
      command: 'create',
      path: 'main.js',
    });
    expect(JSON.parse(finalized[1]!.function.arguments)).toEqual({
      todos: ['task1'],
    });
  });

  it('resets accumulator state cleanly', () => {
    const accumulator = new DemuxingToolAccumulator();
    accumulator.feedChunk({
      index: 0,
      id: 'c1',
      function: { name: 'fn1', arguments: 'abc' },
    });
    expect(accumulator.finalize()).toHaveLength(1);

    accumulator.reset();
    expect(accumulator.finalize()).toHaveLength(0);
  });
});
