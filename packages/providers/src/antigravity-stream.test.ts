import { describe, expect, it } from 'vitest';
import {
  ANTIGRAVITY_API,
  ANTIGRAVITY_PROJECT_HEADER,
  streamAntigravity,
  toAntigravityContents,
} from './antigravity-stream';

const model = {
  id: 'gemini-3.1-pro',
  name: 'gemini-3.1-pro',
  api: ANTIGRAVITY_API,
  provider: 'antigravity',
  baseUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal',
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 65_536,
} as never;

function sseResponse(frames: unknown[], status = 200): Response {
  const body = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('');
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
}

describe('toAntigravityContents', () => {
  it('maps user/assistant/tool turns and merges consecutive tool results', () => {
    const contents = toAntigravityContents([
      { role: 'user', content: 'make pong', timestamp: 0 },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'ok' },
          { type: 'toolCall', id: 'a', name: 'write', arguments: { p: 1 } },
          { type: 'toolCall', id: 'b', name: 'read', arguments: {}, thoughtSignature: 'sig' },
        ],
        api: ANTIGRAVITY_API,
        provider: 'antigravity',
        model: 'm',
        usage: {} as never,
        stopReason: 'toolUse',
        timestamp: 0,
      },
      {
        role: 'toolResult',
        toolCallId: 'a',
        toolName: 'write',
        content: [{ type: 'text', text: 'done' }],
        isError: false,
        timestamp: 0,
      },
      {
        role: 'toolResult',
        toolCallId: 'b',
        toolName: 'read',
        content: [{ type: 'text', text: 'file' }],
        isError: false,
        timestamp: 0,
      },
    ]);
    expect(contents.map((c) => c.role)).toEqual(['user', 'model', 'user']);
    const modelParts = contents[1]?.parts as Array<Record<string, unknown>>;
    // First call without a signature gets Google's documented placeholder; a real one is kept.
    expect(modelParts[1]?.['thoughtSignature']).toBe('skip_thought_signature_validator');
    expect(modelParts[2]?.['thoughtSignature']).toBe('sig');
    expect(contents[2]?.parts).toHaveLength(2);
  });
});

describe('toAntigravityContents turn order', () => {
  it('never ends on a model turn', () => {
    const contents = toAntigravityContents([
      { role: 'user', content: 'go', timestamp: 0 },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'thinking out loud' }],
        api: ANTIGRAVITY_API,
        provider: 'antigravity',
        model: 'm',
        usage: {} as never,
        stopReason: 'stop',
        timestamp: 0,
      },
    ]);
    expect(contents.map((c) => c.role)).toEqual(['user', 'model', 'user']);
  });
});

describe('streamAntigravity', () => {
  it('streams text, whole function calls and usage from Cloud Code frames', async () => {
    let seenUrl = '';
    let seenBody: Record<string, unknown> = {};
    let seenAuth = '';
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seenUrl = url;
      seenBody = JSON.parse(String(init.body));
      seenAuth = (init.headers as Record<string, string>)['Authorization'] ?? '';
      return sseResponse([
        { response: { candidates: [{ content: { parts: [{ text: 'Hel' }] } }] } },
        {
          response: {
            candidates: [
              {
                content: {
                  parts: [
                    { text: 'lo' },
                    {
                      functionCall: { name: 'write', args: { path: 'a.js' } },
                      thoughtSignature: 's',
                    },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, totalTokenCount: 14 },
          },
        },
      ]);
    }) as unknown as typeof fetch;

    const stream = streamAntigravity(
      model,
      {
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
        tools: [
          {
            name: 'write',
            description: 'w',
            parameters: { type: 'object', properties: { path: { type: 'string' } } } as never,
          },
        ],
      },
      { apiKey: 'tok', fetchImpl },
    );
    const types: string[] = [];
    for await (const e of stream) types.push(e.type);
    const result = await stream.result();

    expect(seenUrl).toContain('daily-cloudcode-pa.googleapis.com');
    expect(seenUrl).toContain(':streamGenerateContent?alt=sse');
    expect(seenAuth).toBe('Bearer tok');
    expect(seenBody['model']).toBe('gemini-3.1-pro-low');
    expect(types).toContain('toolcall_end');
    expect(result.stopReason).toBe('toolUse');
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'Hello' });
    expect(result.content[1]).toMatchObject({
      type: 'toolCall',
      name: 'write',
      arguments: { path: 'a.js' },
      thoughtSignature: 's',
    });
    expect(result.usage).toMatchObject({ input: 10, output: 4, totalTokens: 14 });
  });

  it('sends a personal project as body project and never forwards the internal header name', async () => {
    let seenBody: Record<string, unknown> = {};
    let seenHeaders: Record<string, string> = {};
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      seenBody = JSON.parse(String(init.body));
      seenHeaders = init.headers as Record<string, string>;
      return sseResponse([{ response: { candidates: [{ content: { parts: [{ text: 'x' }] } }] } }]);
    }) as unknown as typeof fetch;
    const withProject = {
      ...(model as object),
      headers: { [ANTIGRAVITY_PROJECT_HEADER]: 'my-proj' },
    };
    const s = streamAntigravity(
      withProject as never,
      { messages: [{ role: 'user', content: 'hi', timestamp: 0 }] },
      { apiKey: 'tok', fetchImpl },
    );
    await s.result();
    expect(seenBody['project']).toBe('my-proj');
    expect(seenHeaders['x-goog-user-project']).toBe('my-proj');
    expect(Object.keys(seenHeaders)).not.toContain(ANTIGRAVITY_PROJECT_HEADER);
  });

  it('surfaces an HTTP failure as an error message carrying the status', async () => {
    const fetchImpl = (async () =>
      new Response('quota', { status: 429 })) as unknown as typeof fetch;
    const s = streamAntigravity(
      model,
      { messages: [{ role: 'user', content: 'hi', timestamp: 0 }] },
      { apiKey: 'tok', fetchImpl, sleepImpl: async () => {} },
    );
    const result = await s.result();
    expect(result.stopReason).toBe('error');
    expect(result.errorMessage).toContain('429');
  });

  it('retries a transient 503 and then succeeds, without emitting anything for the failed tries', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const fetchImpl = (async () => {
      calls += 1;
      if (calls < 3) return new Response('{"error":{"status":"UNAVAILABLE"}}', { status: 503 });
      return sseResponse([
        { response: { candidates: [{ content: { parts: [{ text: 'ok' }] } }] } },
      ]);
    }) as unknown as typeof fetch;
    const s = streamAntigravity(
      model,
      { messages: [{ role: 'user', content: 'hi', timestamp: 0 }] },
      { apiKey: 'tok', fetchImpl, sleepImpl: async (ms) => void sleeps.push(ms) },
    );
    const result = await s.result();
    expect(calls).toBe(3);
    expect(sleeps).toHaveLength(2);
    expect(result.stopReason).toBe('stop');
    expect(result.content[0]).toMatchObject({ text: 'ok' });
  });

  it('gives up after the attempt cap and reports the last status', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response('down', { status: 503 });
    }) as unknown as typeof fetch;
    const s = streamAntigravity(
      model,
      { messages: [{ role: 'user', content: 'hi', timestamp: 0 }] },
      { apiKey: 'tok', fetchImpl, sleepImpl: async () => {} },
    );
    const result = await s.result();
    expect(calls).toBe(5);
    expect(result.errorMessage).toContain('503');
  });

  it('does not retry a permanent error', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response('nope', { status: 400 });
    }) as unknown as typeof fetch;
    const s = streamAntigravity(
      model,
      { messages: [{ role: 'user', content: 'hi', timestamp: 0 }] },
      { apiKey: 'tok', fetchImpl, sleepImpl: async () => {} },
    );
    await s.result();
    expect(calls).toBe(1);
  });

  it('maps reasoning onto the tiered Flash thinking level and tops up the output budget', async () => {
    const bodies: Array<Record<string, any>> = [];
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return sseResponse([{ response: { candidates: [{ content: { parts: [{ text: 'x' }] } }] } }]);
    }) as unknown as typeof fetch;
    const ctx = { messages: [{ role: 'user' as const, content: 'hi', timestamp: 0 }] };
    const flash = { ...(model as object), id: 'gemini-3.8-flash-high' } as never;
    await streamAntigravity(flash, ctx, {
      apiKey: 't',
      fetchImpl,
      reasoning: 'minimal',
      maxTokens: 3000,
    }).result();
    await streamAntigravity(model, ctx, { apiKey: 't', fetchImpl, reasoning: 'minimal' }).result();
    expect(bodies[0]?.['request'].generationConfig.thinkingConfig.thinkingLevel).toBe('low');
    // Thinking counts against maxOutputTokens, so a 3000-token reply gets headroom for it.
    expect(bodies[0]?.['request'].generationConfig.maxOutputTokens).toBe(3000 + 8192);
    // A model with no thinking-level setting is left alone (it would 400 on one).
    expect(bodies[1]?.['request'].generationConfig.thinkingConfig).toBeUndefined();
  });

  it('errors clearly with no token', async () => {
    const s = streamAntigravity(model, { messages: [] }, {});
    const result = await s.result();
    expect(result.stopReason).toBe('error');
    expect(result.errorMessage).toMatch(/No Antigravity subscription/);
  });
});
