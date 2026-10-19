import { stream, type Context, type Model } from '@mariozechner/pi-ai';
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

  it('preserves already-normalized signed, image, thinking, and cache_control blocks losslessly', () => {
    const input = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Analyze this image',
            cache_control: { type: 'ephemeral' },
          },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'iVBORw0KGgoAAAANSUhEUg==',
            },
          },
        ],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: 'Analyzing geometry...',
            signature: 'sig_abc123',
          },
          { type: 'text', text: 'Here is the analysis.' },
        ],
      },
    ];

    // biome-ignore lint/suspicious/noExplicitAny: mixed block fixtures
    const result = coalesceAnthropicMessages(input as any);
    expect(result).toHaveLength(2);
    expect(result[0]!.content).toEqual([
      {
        type: 'text',
        text: 'Analyze this image',
        cache_control: { type: 'ephemeral' },
      },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: 'iVBORw0KGgoAAAANSUhEUg==',
        },
      },
    ]);
    expect(result[1]!.content).toEqual([
      {
        type: 'thinking',
        thinking: 'Analyzing geometry...',
        signature: 'sig_abc123',
      },
      { type: 'text', text: 'Here is the analysis.' },
    ]);
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

describe('Production SDK Provider Boundary (@mariozechner/pi-ai stream)', () => {
  const model: Model<'openai-completions'> = {
    id: 'mock-model',
    name: 'mock',
    api: 'openai-completions',
    provider: 'openai',
    baseUrl: 'https://mock.invalid/v1',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 128,
  };

  const context: Context = {
    systemPrompt: 'test',
    messages: [{ role: 'user', content: 'call both', timestamp: 1 }],
    tools: [
      {
        name: 'first',
        description: 'first',
        parameters: { type: 'object', properties: { a: { type: 'string' } } },
      },
      {
        name: 'second',
        description: 'second',
        parameters: { type: 'object', properties: { b: { type: 'string' } } },
      },
    ],
  };

  async function executeStreamFixture(extraDelta?: Record<string, unknown>) {
    const initial = [
      {
        index: 0,
        id: 'call_a',
        type: 'function',
        function: { name: 'first', arguments: '{"a":"' },
      },
      {
        index: 1,
        id: 'call_b',
        type: 'function',
        function: { name: 'second', arguments: '{"b":"' },
      },
    ];
    const deltas: Array<Record<string, unknown>> = [
      { tool_calls: initial },
      { tool_calls: [{ index: 0, function: { arguments: 'one"}' } }] },
      { tool_calls: [{ index: 1, function: { arguments: 'two"}' } }] },
      {},
    ];
    if (extraDelta) {
      deltas.splice(1, 0, extraDelta);
    }

    const frames = deltas.map((delta, i) => ({
      id: 'mock',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'mock',
      choices: [{ index: 0, delta, finish_reason: i === deltas.length - 1 ? 'tool_calls' : null }],
    }));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        `${frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('')}data: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );

    try {
      const endEvents: Array<{ index?: number; toolCall: unknown }> = [];
      const s = stream(model, context, { apiKey: 'fixture-no-credential', maxTokens: 128 });
      for await (const e of s) {
        if (e.type === 'toolcall_end') {
          // Snapshot end-event values while consumed to verify complete arguments at emission time
          endEvents.push({ index: e.contentIndex, toolCall: structuredClone(e.toolCall) });
        }
      }
      const result = await s.result();
      return { result, endEvents };
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  it('correctly streams parallel indexed tool calls without argument corruption or premature ends', async () => {
    const { result, endEvents } = await executeStreamFixture();

    expect(result.stopReason).toBe('toolUse');
    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toEqual({
      type: 'toolCall',
      id: 'call_a',
      name: 'first',
      arguments: { a: 'one' },
    });
    expect(result.content[1]).toEqual({
      type: 'toolCall',
      id: 'call_b',
      name: 'second',
      arguments: { b: 'two' },
    });

    // Exactly one end per tool with complete arguments at receipt
    expect(endEvents).toHaveLength(2);
    expect(endEvents[0]).toEqual({
      index: 0,
      toolCall: {
        type: 'toolCall',
        id: 'call_a',
        name: 'first',
        arguments: { a: 'one' },
      },
    });
    expect(endEvents[1]).toEqual({
      index: 1,
      toolCall: {
        type: 'toolCall',
        id: 'call_b',
        name: 'second',
        arguments: { b: 'two' },
      },
    });
  });

  it('preserves request-wide tool state across interleaved text chunks', async () => {
    const { result, endEvents } = await executeStreamFixture({ content: 'Still working' });

    expect(result.stopReason).toBe('toolUse');
    const toolCalls = result.content.filter((b) => b.type === 'toolCall');
    const textBlocks = result.content.filter((b) => b.type === 'text');
    expect(toolCalls).toHaveLength(2);
    expect(textBlocks).toHaveLength(1);
    expect(toolCalls[0]).toEqual({
      type: 'toolCall',
      id: 'call_a',
      name: 'first',
      arguments: { a: 'one' },
    });
    expect(toolCalls[1]).toEqual({
      type: 'toolCall',
      id: 'call_b',
      name: 'second',
      arguments: { b: 'two' },
    });

    expect(endEvents).toHaveLength(2);
    expect(endEvents[0]!.toolCall).toEqual({
      type: 'toolCall',
      id: 'call_a',
      name: 'first',
      arguments: { a: 'one' },
    });
    expect(endEvents[1]!.toolCall).toEqual({
      type: 'toolCall',
      id: 'call_b',
      name: 'second',
      arguments: { b: 'two' },
    });
  });

  it('preserves request-wide tool state across interleaved reasoning/thinking chunks', async () => {
    const { result, endEvents } = await executeStreamFixture({
      reasoning_content: 'Still reasoning',
    });

    expect(result.stopReason).toBe('toolUse');
    const toolCalls = result.content.filter((b) => b.type === 'toolCall');
    const thinkingBlocks = result.content.filter((b) => b.type === 'thinking');
    expect(toolCalls).toHaveLength(2);
    expect(thinkingBlocks).toHaveLength(1);
    expect(toolCalls[0]).toEqual({
      type: 'toolCall',
      id: 'call_a',
      name: 'first',
      arguments: { a: 'one' },
    });
    expect(toolCalls[1]).toEqual({
      type: 'toolCall',
      id: 'call_b',
      name: 'second',
      arguments: { b: 'two' },
    });

    expect(endEvents).toHaveLength(2);
    expect(endEvents[0]!.toolCall).toEqual({
      type: 'toolCall',
      id: 'call_a',
      name: 'first',
      arguments: { a: 'one' },
    });
    expect(endEvents[1]!.toolCall).toEqual({
      type: 'toolCall',
      id: 'call_b',
      name: 'second',
      arguments: { b: 'two' },
    });
  });
});
