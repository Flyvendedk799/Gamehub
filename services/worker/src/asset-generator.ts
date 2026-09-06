/**
 * generateImageAsset — provider-agnostic image generation for the gen-worker.
 *
 * S6 — multi-provider switch:
 *   1. Default / Claude path: when PLATFORM_PROVIDER is anthropic (or anything
 *      non-OpenAI), look for OPENAI_API_KEY / PLAYFORGE_IMAGE_API_KEY as an
 *      OpenAI Images fallback. If none, fail loudly with draw-in-code guidance.
 *   2. OpenAI path: call gpt-image-1 directly with the run credential.
 *
 * Model note: `dall-e-3` was retired (2026-03-04) and the legacy
 * `response_format` parameter is no longer accepted by the images endpoint —
 * the gpt-image-* series ALWAYS returns base64 in `data[].b64_json`.
 */

import type { GenerateImageAssetFn, GenerateImageAssetRequest } from '@playforge/agent-core';
import { assertSafeUrl } from '@playforge/shared';

const ASPECT_TO_SIZE: Record<string, string> = {
  '1:1': '1024x1024',
  '16:9': '1536x1024',
  '9:16': '1024x1536',
  '4:3': '1536x1024',
  '3:4': '1024x1536',
};

const IMAGE_MODEL = 'gpt-image-1';

/** Resolve which credential can hit the OpenAI Images API. */
export function resolveImageCredential(
  provider: string,
  apiKey: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { apiKey: string; provider: 'openai'; via: 'primary' | 'fallback' } | null {
  if (provider === 'openai' && apiKey && canGenerateImages('openai', apiKey)) {
    return { apiKey, provider: 'openai', via: 'primary' };
  }
  const fallback =
    env['PLAYFORGE_IMAGE_API_KEY']?.trim() ||
    env['OPENAI_API_KEY']?.trim() ||
    '';
  if (fallback.length > 0 && canGenerateImages('openai', fallback)) {
    return { apiKey: fallback, provider: 'openai', via: 'fallback' };
  }
  return null;
}

/**
 * Can this credential (or a configured OpenAI fallback) generate images?
 */
export function canGenerateImages(provider: string, apiKey: string | undefined): boolean {
  if (!apiKey || apiKey.trim().length === 0) return false;
  if (/placeholder|changeme|your[-_]?key|sk-ant-placeho/i.test(apiKey)) return false;
  // Primary path is OpenAI Images. Non-openai providers rely on resolveImageCredential
  // finding a fallback key — this helper only validates a key that will be sent
  // to the images endpoint.
  if (provider !== 'openai') return false;
  return true;
}

/** True when the run can offer generate_image_asset (primary OpenAI or fallback). */
export function canOfferImageGeneration(
  provider: string,
  apiKey: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return resolveImageCredential(provider, apiKey, env) !== null;
}

export function makeAssetGenerator(opts: {
  apiKey: string;
  provider: string;
  /** Optional env override for tests. */
  env?: NodeJS.ProcessEnv;
}): GenerateImageAssetFn {
  return async (request: GenerateImageAssetRequest, signal?: AbortSignal) => {
    const { prompt, purpose, aspectRatio = '1:1', filenameHint, alt } = request;
    const path = filenameHint ?? `assets/${purpose}-${Date.now()}.png`;

    const cred = resolveImageCredential(opts.provider, opts.apiKey, opts.env ?? process.env);
    if (cred === null) {
      throw new Error(
        `generate_image_asset is unavailable on this deployment (image generation needs an OpenAI Images credential; this run uses "${opts.provider}" with no OPENAI_API_KEY / PLAYFORGE_IMAGE_API_KEY fallback). Do NOT retry, and do NOT reference a bitmap you did not create — it would 404 and render as nothing. Draw the art in code instead: canvas-rendered sprites, inline <svg>, CSS gradients, or generated geometry/materials. Code-drawn art that renders beats a bitmap that does not exist.`,
      );
    }

    const size = ASPECT_TO_SIZE[aspectRatio] ?? '1024x1024';
    const fullPrompt = `${prompt}. Purpose: ${purpose}. Alt text: ${alt ?? purpose}.`;

    const imageEndpoint = 'https://api.openai.com/v1/images/generations';
    await assertSafeUrl(imageEndpoint);
    const res = await fetch(imageEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cred.apiKey}`,
      },
      body: JSON.stringify({
        model: IMAGE_MODEL,
        prompt: fullPrompt,
        n: 1,
        size,
        quality: 'low',
      }),
      ...(signal != null ? { signal } : {}),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(
        `[asset-generator] OpenAI images API error ${res.status} (purpose=${purpose}, size=${size}, via=${cred.via}): ${text}`,
      );
      throw new Error(
        `generate_image_asset failed: images API returned ${res.status}. ${res.status === 429 ? 'Rate limited — try ONE more time, then ' : 'Do not retry more than once; '}fall back to drawing this asset in code (canvas, inline <svg>, CSS, or generated geometry). Never reference a bitmap path you did not successfully create.`,
      );
    }

    const json = (await res.json()) as {
      data?: Array<{ b64_json?: string; revised_prompt?: string }>;
    };
    const b64 = json.data?.[0]?.b64_json;
    if (!b64) {
      console.warn(`[asset-generator] images response carried no b64_json (purpose=${purpose})`);
      throw new Error(
        'generate_image_asset failed: the images API returned no image data. ' +
          'Draw this asset in code instead (canvas, inline <svg>, CSS, or generated geometry), ' +
          'and do not reference a bitmap path you did not successfully create.',
      );
    }

    return {
      path,
      dataUrl: `data:image/png;base64,${b64}`,
      mimeType: 'image/png',
      model: IMAGE_MODEL,
      provider: 'openai',
      revisedPrompt: json.data?.[0]?.revised_prompt,
    };
  };
}
