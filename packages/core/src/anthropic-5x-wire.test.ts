import { stream, streamSimple } from '@mariozechner/pi-ai';
/**
 * Request bodies pi-ai builds for the Claude 5 generation. The patched adapter must never send
 * what these models reject with a 400 — `thinking: disabled` on Sonnet 5.5 / Opus 5.5 / Fable,
 * `budget_tokens`, a forced `tool_choice`, sampling params — and these tests are the guard that
 * a pi-ai bump or patch regeneration has not dropped that. No network: `onPayload` captures the
 * body and aborts the request.
 */
import type { ModelRef } from '@playforge/shared';
import { describe, expect, it } from 'vitest';
import { buildPiModel } from './agent';

type Body = Record<string, unknown>;

const CONTEXT = {
  systemPrompt: 'You build games.',
  messages: [{ role: 'user' as const, content: 'make a platformer', timestamp: 0 }],
  tools: [
    {
      name: 'done',
      description: 'finish',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  ],
};

async function captureBody(
  modelId: string,
  options: Record<string, unknown>,
  via: 'stream' | 'streamSimple' = 'stream',
): Promise<Body> {
  const model = buildPiModel({ provider: 'anthropic', modelId } as ModelRef, undefined, undefined);
  let captured: Body | undefined;
  const opts = {
    apiKey: 'sk-ant-test',
    ...options,
    onPayload: (params: Body) => {
      captured = JSON.parse(JSON.stringify(params)) as Body;
      throw new Error('captured');
    },
  };
  // biome-ignore lint/suspicious/noExplicitAny: pi-ai's option types are generic over the wire.
  const s = (via === 'stream' ? stream : streamSimple)(model, CONTEXT as any, opts as any);
  await s.result().catch(() => undefined);
  if (captured === undefined) throw new Error('request body was never built');
  return captured;
}

const NEW_GEN = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1'];

describe('thinking off', () => {
  it('Sonnet 5.5 uses between_tools, never disabled', async () => {
    const body = await captureBody('claude-sonnet-5-5', { thinkingEnabled: false });
    expect(body['thinking']).toEqual({ type: 'between_tools' });
  });

  it.each(['claude-opus-5-5', 'claude-fable-5-1'])(
    '%s omits thinking (it cannot be switched off) and keeps effort as the control',
    async (id) => {
      const body = await captureBody(id, { thinkingEnabled: false, effort: 'low' });
      expect(body).not.toHaveProperty('thinking');
      expect(body['output_config']).toEqual({ effort: 'low' });
    },
  );

  it('still sends disabled to models that accept it', async () => {
    const body = await captureBody('claude-sonnet-4-6', { thinkingEnabled: false });
    expect(body['thinking']).toEqual({ type: 'disabled' });
  });

  it('a simple call without reasoning does not send disabled to the 5.5 models', async () => {
    for (const id of NEW_GEN) {
      const body = await captureBody(id, {}, 'streamSimple');
      expect(body['thinking']).not.toEqual({ type: 'disabled' });
    }
  });
});

describe('thinking on', () => {
  it.each(NEW_GEN)('%s uses adaptive thinking with effort, never budget_tokens', async (id) => {
    const body = await captureBody(id, { thinkingEnabled: true, effort: 'medium' });
    expect(body['thinking']).toMatchObject({ type: 'adaptive' });
    expect(JSON.stringify(body['thinking'])).not.toContain('budget_tokens');
    expect(body['output_config']).toEqual({ effort: 'medium' });
  });

  it('reasoning through streamSimple maps to adaptive on the 5.5 models too', async () => {
    const body = await captureBody('claude-sonnet-5-5', { reasoning: 'medium' }, 'streamSimple');
    expect(body['thinking']).toMatchObject({ type: 'adaptive' });
  });
});

describe('forced tool choice and sampling', () => {
  it.each(NEW_GEN)('%s never gets tool_choice any/tool', async (id) => {
    const body = await captureBody(id, { toolChoice: 'any', thinkingEnabled: false });
    expect(body).not.toHaveProperty('tool_choice');
  });

  it('an explicit tool choice is dropped too', async () => {
    const body = await captureBody('claude-opus-5-5', {
      toolChoice: { type: 'tool', name: 'done' },
    });
    expect(body).not.toHaveProperty('tool_choice');
  });

  it('models that accept a forced choice still get it', async () => {
    const body = await captureBody('claude-sonnet-4-6', {
      toolChoice: 'any',
      thinkingEnabled: false,
    });
    expect(body['tool_choice']).toEqual({ type: 'any' });
  });

  it.each(NEW_GEN)('%s is not sent a temperature', async (id) => {
    const body = await captureBody(id, { thinkingEnabled: false, temperature: 0.7 });
    expect(body).not.toHaveProperty('temperature');
  });
});
