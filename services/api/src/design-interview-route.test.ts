/**
 * POST /v1/design/interview — the questions asked before a build.
 *
 * The contract worth pinning is that this route is BEST-EFFORT. It sits in
 * front of every build, so a slow or broken model must degrade to the static
 * questions rather than stop someone making a game. Everything here is a
 * variation on "the model misbehaved; did a person still get to build?".
 *
 * `complete` is mocked in this file only. Mocking it in the main server suite
 * would replace the credential readers that suite depends on.
 */

import { InMemoryEventBus } from '@playforge/bus';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const complete = vi.fn();

vi.mock('@playforge/providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@playforge/providers')>()),
  complete: (...args: unknown[]) => complete(...args),
}));

const { HeaderAuthenticator } = await import('./auth');
const { InMemoryProjectRepo } = await import('./repo');
const { InMemoryRunRepo } = await import('./run-repo');
const { buildServer } = await import('./server');

const AS_ALICE = { 'x-user-id': 'alice' };

function makeApp(overrides: { noCredential?: boolean } = {}) {
  return buildServer({
    repo: new InMemoryProjectRepo(),
    auth: new HeaderAuthenticator(),
    bus: new InMemoryEventBus(),
    runRepo: new InMemoryRunRepo(),
    enqueue: async () => {},
    platformModel: { provider: 'anthropic', modelId: 'claude-sonnet-4-6' },
    ...(overrides.noCredential === true ? {} : { platformApiKey: 'sk-test' }),
  });
}

/** A plan of the shape the model is asked to produce. */
const PLAN = {
  settled: [{ layer: 'world', value: 'a flooded neon city' }],
  questions: [
    {
      layer: 'cast',
      title: 'Who you play',
      question: 'Who is moving through the flooded city?',
      why: 'Decides the sprites and how movement should feel.',
      placeholder: 'A salvage diver, a courier…',
      options: [
        { label: 'A salvage diver', detail: 'Slow, heavy, tethered' },
        { label: 'A courier on a jet-ski', detail: 'Fast, exposed, loud' },
      ],
    },
  ],
};

function respondWith(content: string) {
  complete.mockResolvedValue({
    content,
    inputTokens: 100,
    outputTokens: 200,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    costUsd: 0.001,
  });
}

describe('POST /v1/design/interview', () => {
  beforeEach(() => {
    complete.mockReset();
  });

  it('returns questions written for the prompt', async () => {
    respondWith(JSON.stringify(PLAN));
    const res = await makeApp().inject({
      method: 'POST',
      url: '/v1/design/interview',
      headers: AS_ALICE,
      payload: { prompt: 'a game set in a flooded neon city' },
    });

    expect(res.statusCode).toBe(200);
    const { plan } = res.json() as { plan: { settled: unknown[]; questions: { id: string }[] } };
    expect(plan.settled).toEqual([{ layer: 'world', value: 'a flooded neon city' }]);
    expect(plan.questions.map((q) => q.id)).toEqual(['cast']);

    // The prompt reaches the model — the entire point of the route.
    const instruction = complete.mock.calls[0]?.[1]?.[0]?.content as string;
    expect(instruction).toContain('a game set in a flooded neon city');
  });

  it('falls back rather than failing when the model throws', async () => {
    complete.mockRejectedValue(new Error('upstream 529'));
    const res = await makeApp().inject({
      method: 'POST',
      url: '/v1/design/interview',
      headers: AS_ALICE,
      payload: { prompt: 'a game about a cat' },
    });

    // 200 with a null plan, NOT an error: the client shows the static questions
    // and the person still gets to build.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ plan: null });
  });

  it('falls back when the model returns prose, or an unusable plan', async () => {
    respondWith('I would love to help you build that game!');
    const prose = await makeApp().inject({
      method: 'POST',
      url: '/v1/design/interview',
      headers: AS_ALICE,
      payload: { prompt: 'a game about a cat' },
    });
    expect(prose.json()).toEqual({ plan: null });

    respondWith(JSON.stringify({ settled: [], questions: [{ layer: 'nonsense' }] }));
    const unusable = await makeApp().inject({
      method: 'POST',
      url: '/v1/design/interview',
      headers: AS_ALICE,
      payload: { prompt: 'a game about a cat' },
    });
    expect(unusable.json()).toEqual({ plan: null });
  });

  it('reads a plan the model wrapped in a code fence', async () => {
    respondWith(`Sure!\n\`\`\`json\n${JSON.stringify(PLAN)}\n\`\`\``);
    const res = await makeApp().inject({
      method: 'POST',
      url: '/v1/design/interview',
      headers: AS_ALICE,
      payload: { prompt: 'a flooded city game' },
    });
    const { plan } = res.json() as { plan: { questions: unknown[] } | null };
    expect(plan?.questions).toHaveLength(1);
  });

  it('falls back when there is no credential to call with', async () => {
    const res = await makeApp({ noCredential: true }).inject({
      method: 'POST',
      url: '/v1/design/interview',
      headers: AS_ALICE,
      payload: { prompt: 'a game about a cat' },
    });
    expect(res.json()).toEqual({ plan: null });
    expect(complete).not.toHaveBeenCalled();
  });

  it('requires auth', async () => {
    const res = await makeApp().inject({
      method: 'POST',
      url: '/v1/design/interview',
      payload: { prompt: 'a game about a cat' },
    });
    expect(res.statusCode).toBe(401);
    expect(complete).not.toHaveBeenCalled();
  });

  it('rejects an empty or over-long prompt without calling the model', async () => {
    const app = makeApp();
    const empty = await app.inject({
      method: 'POST',
      url: '/v1/design/interview',
      headers: AS_ALICE,
      payload: { prompt: '   ' },
    });
    expect(empty.statusCode).toBe(400);

    const long = await app.inject({
      method: 'POST',
      url: '/v1/design/interview',
      headers: AS_ALICE,
      payload: { prompt: 'x'.repeat(2001) },
    });
    expect(long.statusCode).toBe(400);
    expect(complete).not.toHaveBeenCalled();
  });
});
