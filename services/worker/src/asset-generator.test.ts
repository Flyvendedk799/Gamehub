/**
 * Asset generation must never claim success for art it did not produce.
 */

import { describe, expect, it } from 'vitest';
import {
  canGenerateImages,
  canOfferImageGeneration,
  makeAssetGenerator,
  resolveImageCredential,
} from './asset-generator';

describe('canGenerateImages', () => {
  it('requires an OpenAI credential — the images API is OpenAI-only', () => {
    expect(canGenerateImages('openai', 'sk-real-key-value')).toBe(true);
    expect(canGenerateImages('anthropic', 'sk-ant-real-key')).toBe(false);
    expect(canGenerateImages('google', 'key')).toBe(false);
  });

  it('treats a missing or blank key as unavailable', () => {
    expect(canGenerateImages('openai', undefined)).toBe(false);
    expect(canGenerateImages('openai', '')).toBe(false);
    expect(canGenerateImages('openai', '   ')).toBe(false);
  });

  it('treats an unprovisioned placeholder key as unavailable', () => {
    expect(canGenerateImages('openai', 'sk-ant-placeholder')).toBe(false);
    expect(canGenerateImages('openai', 'sk-PLACEHOLDER-value')).toBe(false);
    expect(canGenerateImages('openai', 'changeme')).toBe(false);
    expect(canGenerateImages('openai', 'your-key-here')).toBe(false);
  });
});

describe('S6 multi-provider image switch', () => {
  it('falls back to OPENAI_API_KEY when the run provider is Claude', () => {
    const cred = resolveImageCredential('anthropic', 'sk-ant-real', {
      OPENAI_API_KEY: 'sk-openai-fallback',
    });
    expect(cred?.via).toBe('fallback');
    expect(cred?.provider).toBe('openai');
  });

  it('canOfferImageGeneration is true for Claude when a fallback key exists', () => {
    expect(
      canOfferImageGeneration('anthropic', 'sk-ant-real', {
        PLAYFORGE_IMAGE_API_KEY: 'sk-openai-images',
      }),
    ).toBe(true);
  });
});

describe('makeAssetGenerator', () => {
  it('fails loudly instead of returning a transparent pixel', async () => {
    const generate = makeAssetGenerator({
      apiKey: 'sk-ant-whatever',
      provider: 'anthropic',
      env: {},
    });
    await expect(generate({ prompt: 'a hero sprite', purpose: 'sprite' })).rejects.toThrow(
      /unavailable on this deployment/,
    );
  });

  it('tells the agent what to do instead of retrying', async () => {
    const generate = makeAssetGenerator({
      apiKey: 'sk-ant-whatever',
      provider: 'anthropic',
      env: {},
    });
    await expect(generate({ prompt: 'a hero sprite', purpose: 'sprite' })).rejects.toThrow(
      /Draw the art in code/,
    );
  });
});
