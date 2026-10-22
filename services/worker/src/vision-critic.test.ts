import type { complete } from '@playforge/providers';
import { describe, expect, it, vi } from 'vitest';
import { makeVisionCritic } from './vision-critic';

describe('auxiliary provider routing', () => {
  it('preserves endpoint, wire and headers while refreshing credentials on each critique', async () => {
    const completion = vi.fn<typeof complete>().mockResolvedValue({
      content: 'VERDICT: PASS',
      inputTokens: 1,
      outputTokens: 1,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUsd: 0,
    });
    const getApiKey = vi.fn().mockResolvedValueOnce('fresh-one').mockResolvedValueOnce('fresh-two');
    const critic = makeVisionCritic(
      {
        model: { provider: 'custom', modelId: 'vision' },
        options: {
          apiKey: 'expired',
          baseUrl: 'https://gateway.example/v1',
          wire: 'anthropic',
          httpHeaders: { 'x-account': 'test' },
        },
        getApiKey,
      },
      completion,
    );
    const frame = { pngBase64: 'frame', mimeType: 'image/png', prompt: 'Review this frame' };
    await critic(frame);
    await critic(frame);
    expect(completion.mock.calls[1]?.[2]).toEqual({
      apiKey: 'fresh-two',
      baseUrl: 'https://gateway.example/v1',
      wire: 'anthropic',
      httpHeaders: { 'x-account': 'test' },
      maxTokens: 500,
      userImages: [{ data: 'frame', mimeType: 'image/png' }],
    });
  });
});
