import { describe, expect, it } from 'vitest';
import { createSubscriptionTokenSource } from './subscription-token';

const source = createSubscriptionTokenSource({
  client: { unsafe: async () => [] },
  secret: 'test-secret',
});

describe('subscription token source', () => {
  it('gives an Antigravity job a getter for its own user', () => {
    const getter = source.forJob({
      userId: 'u1',
      wire: 'antigravity-cloudcode',
      provider: 'antigravity',
      apiKey: 'ya29.stale',
    });
    expect(typeof getter).toBe('function');
  });

  it('gives a Claude Code (OAuth token) job a getter, but not a pasted API key', () => {
    const oauth = source.forJob({
      userId: 'u1',
      wire: undefined,
      provider: 'anthropic',
      apiKey: 'sk-ant-oat01-abc',
    });
    const key = source.forJob({
      userId: 'u1',
      wire: undefined,
      provider: 'anthropic',
      apiKey: 'sk-ant-api03-abc',
    });
    expect(typeof oauth).toBe('function');
    expect(key).toBeUndefined();
  });

  it('gives platform / Codex / anonymous jobs nothing to refresh', () => {
    expect(
      source.forJob({ userId: 'u1', wire: undefined, provider: 'openai', apiKey: 'sk-x' }),
    ).toBeUndefined();
    expect(
      source.forJob({
        userId: undefined,
        wire: 'antigravity-cloudcode',
        provider: 'antigravity',
        apiKey: 't',
      }),
    ).toBeUndefined();
  });

  it('a getter with no stored login fails loudly instead of returning a stale token', async () => {
    const getter = source.forJob({
      userId: 'nobody',
      wire: 'antigravity-cloudcode',
      provider: 'antigravity',
      apiKey: 'ya29.stale',
    });
    await expect(getter?.()).rejects.toThrow();
  });
});
