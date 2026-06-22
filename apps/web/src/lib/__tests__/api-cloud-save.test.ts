import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearCloudSave, getCloudSave, setCloudSave } from '../api';

/**
 * Regression for the cloud-save clear() bug the Playwright E2E surfaced: a
 * bodyless DELETE that still declared `Content-Type: application/json` tripped
 * Fastify's empty-JSON-body guard (400 FST_ERR_CTP_EMPTY_JSON_BODY). The fix:
 * apiFetch only sends the JSON content-type when there is actually a body.
 */
function captureFetch(): { headersFor: (call: number) => Headers } {
  const calls: Headers[] = [];
  const stub: typeof fetch = async (_url, init) => {
    calls.push(new Headers(init?.headers));
    return new Response(JSON.stringify({ ok: true, value: null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  vi.stubGlobal('fetch', stub);
  return { headersFor: (i) => calls[i] ?? new Headers() };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('cloud-save API client — Content-Type only with a body', () => {
  it('PUT (with body) sends Content-Type: application/json', async () => {
    const cap = captureFetch();
    await setCloudSave('p1', 'slot1', { hp: 42 });
    expect(cap.headersFor(0).get('content-type')).toBe('application/json');
  });

  it('bodyless DELETE does NOT send Content-Type (avoids the empty-JSON-body 400)', async () => {
    const cap = captureFetch();
    await clearCloudSave('p1', 'slot1');
    expect(cap.headersFor(0).get('content-type')).toBeNull();
  });

  it('bodyless GET does NOT send Content-Type', async () => {
    const cap = captureFetch();
    await getCloudSave('p1', 'slot1');
    expect(cap.headersFor(0).get('content-type')).toBeNull();
  });

  it('clear-all (key=null) is a bodyless DELETE with no Content-Type', async () => {
    const cap = captureFetch();
    await clearCloudSave('p1', null);
    expect(cap.headersFor(0).get('content-type')).toBeNull();
  });
});
