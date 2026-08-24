/**
 * Asset generation must never claim success for art it did not produce.
 *
 * The behaviour these pin replaced a silent fallback: when the credential could
 * not reach the images API, the generator returned a 1×1 transparent PNG and
 * reported success. The agent wrote that pixel into the game as if it were art,
 * the build report counted the asset, and every game built on a non-OpenAI
 * credential shipped invisible sprites with nothing anywhere saying so.
 */

import { describe, expect, it } from 'vitest';
import { canGenerateImages, makeAssetGenerator } from './asset-generator';

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
    // Deployments carry a literal placeholder when image generation was never
    // set up. Production had exactly this, so every request was doomed before
    // it left the process.
    expect(canGenerateImages('openai', 'sk-ant-placeholder')).toBe(false);
    expect(canGenerateImages('openai', 'sk-PLACEHOLDER-value')).toBe(false);
    expect(canGenerateImages('openai', 'changeme')).toBe(false);
    expect(canGenerateImages('openai', 'your-key-here')).toBe(false);
  });
});

describe('makeAssetGenerator', () => {
  it('fails loudly instead of returning a transparent pixel', async () => {
    const generate = makeAssetGenerator({ apiKey: 'sk-ant-whatever', provider: 'anthropic' });
    await expect(generate({ prompt: 'a hero sprite', purpose: 'sprite' })).rejects.toThrow(
      /unavailable on this deployment/,
    );
  });

  it('tells the agent what to do instead of retrying', async () => {
    // The error is the agent's only signal here, so it has to carry the
    // recovery: draw it in code, and never reference a bitmap that does not
    // exist (a 404 renders as nothing, silently).
    const generate = makeAssetGenerator({ apiKey: 'sk-ant-whatever', provider: 'anthropic' });
    const error = await generate({ prompt: 'a hero sprite', purpose: 'sprite' }).catch(
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
    expect(error).toMatch(/do NOT retry/i);
    expect(error).toMatch(/canvas|svg|css/i);
    expect(error).toMatch(/404|did not create/i);
  });
});
