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

// ---------------------------------------------------------------------------
// SSRF guard
// ---------------------------------------------------------------------------
// Infrastructure for any future dynamic fetch (e.g. read_url tool, provider
// URL from config). The hardcoded https://api.openai.com call below is always
// safe, but we run it through assertSafeUrl anyway so the guard is exercised
// on every request and proven live.
// ---------------------------------------------------------------------------

/**
 * Asserts that `url` is safe to fetch server-side.
 *
 * Rules:
 *  - Protocol must be `https:` (no http, file, ftp, data, …)
 *  - Hostname must not resolve to RFC 1918, loopback, link-local, or
 *    APIPA/metadata addresses (hostname-pattern matching; DNS rebinding is
 *    a separate concern handled at the network layer).
 *
 * Throws `Error('SSRF_BLOCKED: <hostname>')` when a rule is violated.
 */
export function assertSafeUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`SSRF_BLOCKED: invalid URL — ${url}`);
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(`SSRF_BLOCKED: protocol not allowed — ${parsed.protocol}`);
  }

  const host = parsed.hostname.toLowerCase();

  // Loopback
  if (host === 'localhost' || host === '::1' || host === '0.0.0.0') {
    throw new Error(`SSRF_BLOCKED: ${host}`);
  }

  // IPv4 pattern checks
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4 !== null) {
    const [, a, b, c] = v4;
    const oa = Number(a);
    const ob = Number(b);
    const oc = Number(c);

    // 127.0.0.0/8 — loopback
    if (oa === 127) throw new Error(`SSRF_BLOCKED: ${host}`);

    // 10.0.0.0/8 — private
    if (oa === 10) throw new Error(`SSRF_BLOCKED: ${host}`);

    // 172.16.0.0/12 — private (172.16.x.x – 172.31.x.x)
    if (oa === 172 && ob >= 16 && ob <= 31) throw new Error(`SSRF_BLOCKED: ${host}`);

    // 192.168.0.0/16 — private
    if (oa === 192 && ob === 168) throw new Error(`SSRF_BLOCKED: ${host}`);

    // 169.254.0.0/16 — link-local / AWS metadata (169.254.169.254)
    if (oa === 169 && ob === 254) throw new Error(`SSRF_BLOCKED: ${host}`);

    // 0.0.0.0/8
    if (oa === 0) throw new Error(`SSRF_BLOCKED: ${host}`);

    // Suppress unused-variable lint for `c` — we may extend checks later.
    void oc;
  }
}

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

    const imageEndpoint = 'https://api.openai.com/v1/images/generations';
    assertSafeUrl(imageEndpoint);
    const res = await fetch(imageEndpoint, {
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
