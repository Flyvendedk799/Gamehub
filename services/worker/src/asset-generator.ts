/**
 * generateImageAsset — inline image generation for the gen-worker.
 *
 * Calls the OpenAI Images API (gpt-image-1) to produce a PNG and returns it as
 * a data URL so the agent can write it into the working tree.
 *
 * Model note: `dall-e-3` was retired (2026-03-04) and the legacy
 * `response_format` parameter is no longer accepted by the images endpoint —
 * the gpt-image-* series ALWAYS returns base64 in `data[].b64_json`, so we send
 * no `response_format` and read b64_json directly. (Sending the old model/param
 * produced a hard `400 Unknown parameter: 'response_format'` that silently
 * dropped every asset to the placeholder PNG.)
 *
 * In the future this can be extracted to a dedicated asset-worker that
 * processes BullMQ `asset-jobs` in parallel. The `GenerateImageAssetFn`
 * contract is identical either way, so the migration is a drop-in swap.
 *
 * Required: PLATFORM_API_KEY must be set and PLATFORM_PROVIDER must be 'openai'.
 * When the provider isn't OpenAI, a transparent 1×1 PNG placeholder is returned
 * so the agent run still completes.
 */

import type { GenerateImageAssetFn, GenerateImageAssetRequest } from '@playforge/agent-core';
// The ONE canonical SSRF guard. Any server-side fetch of a URL that is
// attacker/model/config-influenced runs through this (async, DNS-aware) guard.
// Do not re-fork a local blocklist — see packages/shared/src/ssrf.ts.
import { assertSafeUrl } from '@playforge/shared';

// gpt-image-1 supports a fixed set of sizes: 1024x1024 (square),
// 1536x1024 (landscape), 1024x1536 (portrait), and 'auto'. The legacy
// dall-e-3 1792-wide sizes are rejected, so map every aspect onto these three.
const ASPECT_TO_SIZE: Record<string, string> = {
  '1:1': '1024x1024',
  '16:9': '1536x1024',
  '9:16': '1024x1536',
  '4:3': '1536x1024',
  '3:4': '1024x1536',
};

const IMAGE_MODEL = 'gpt-image-1';

// 1×1 transparent PNG — fallback when image generation isn't available.
const PLACEHOLDER_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

export function makeAssetGenerator(opts: {
  apiKey: string;
  provider: string;
}): GenerateImageAssetFn {
  return async (request: GenerateImageAssetRequest, signal?: AbortSignal) => {
    const { prompt, purpose, aspectRatio = '1:1', filenameHint, alt } = request;
    const path = filenameHint ?? `assets/${purpose}-${Date.now()}.png`;

    if (opts.provider !== 'openai') {
      return {
        path,
        dataUrl: PLACEHOLDER_PNG,
        mimeType: 'image/png',
        model: 'placeholder',
        provider: opts.provider,
      };
    }

    const size = ASPECT_TO_SIZE[aspectRatio] ?? '1024x1024';
    const fullPrompt = `${prompt}. Purpose: ${purpose}. Alt text: ${alt ?? purpose}.`;

    const imageEndpoint = 'https://api.openai.com/v1/images/generations';
    await assertSafeUrl(imageEndpoint);
    const res = await fetch(imageEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        model: IMAGE_MODEL,
        prompt: fullPrompt,
        n: 1,
        size,
        // Keep game sprites cheap + fast; the agent only needs serviceable art.
        quality: 'low',
      }),
      ...(signal != null ? { signal } : {}),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(
        `[asset-generator] OpenAI images API error ${res.status} (purpose=${purpose}, size=${size}): ${text}`,
      );
      return {
        path,
        dataUrl: PLACEHOLDER_PNG,
        mimeType: 'image/png',
        model: IMAGE_MODEL,
        provider: 'openai',
      };
    }

    const json = (await res.json()) as {
      data?: Array<{ b64_json?: string; revised_prompt?: string }>;
    };
    const b64 = json.data?.[0]?.b64_json;
    if (!b64) {
      console.warn(`[asset-generator] images response carried no b64_json (purpose=${purpose})`);
      return {
        path,
        dataUrl: PLACEHOLDER_PNG,
        mimeType: 'image/png',
        model: IMAGE_MODEL,
        provider: 'openai',
      };
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
