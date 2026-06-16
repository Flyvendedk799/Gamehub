/**
 * generateImageAsset — inline image generation for the gen-worker.
 *
 * Calls the OpenAI Images API (dall-e-3) to produce a PNG and returns it as a
 * data URL so the agent can write it into the working tree.
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

const ASPECT_TO_SIZE: Record<string, string> = {
  '1:1': '1024x1024',
  '16:9': '1792x1024',
  '9:16': '1024x1792',
  '4:3': '1792x1024',
  '3:4': '1024x1792',
};

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
      return { path, dataUrl: PLACEHOLDER_PNG, mimeType: 'image/png', model: 'placeholder', provider: opts.provider };
    }

    const size = ASPECT_TO_SIZE[aspectRatio] ?? '1024x1024';
    const fullPrompt = `${prompt}. Purpose: ${purpose}. Alt text: ${alt ?? purpose}.`;

    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        model: 'dall-e-3',
        prompt: fullPrompt,
        n: 1,
        size,
        response_format: 'b64_json',
      }),
      ...(signal != null ? { signal } : {}),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(`[asset-generator] OpenAI images API error ${res.status}: ${text}`);
      return { path, dataUrl: PLACEHOLDER_PNG, mimeType: 'image/png', model: 'dall-e-3', provider: 'openai' };
    }

    const json = await res.json() as { data?: Array<{ b64_json?: string; revised_prompt?: string }> };
    const b64 = json.data?.[0]?.b64_json;
    if (!b64) {
      return { path, dataUrl: PLACEHOLDER_PNG, mimeType: 'image/png', model: 'dall-e-3', provider: 'openai' };
    }

    return {
      path,
      dataUrl: `data:image/png;base64,${b64}`,
      mimeType: 'image/png',
      model: 'dall-e-3',
      provider: 'openai',
      revisedPrompt: json.data?.[0]?.revised_prompt,
    };
  };
}
