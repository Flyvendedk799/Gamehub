/**
 * Tests for the browser-worker — IMPROVEMENT_BACKLOG #11.
 *
 * These tests launch the REAL headless Chromium that is already a dependency
 * (playwright). They cover the two highest-risk behaviours of this surface:
 *   1. the runtime-verify __game-contract verdict (true / false / load-error)
 *   2. the network egress lockdown (#3) that blocks SSRF / exfiltration from
 *      inside untrusted game code.
 *
 * Hermetic: no real external network is required. The verdict tests inline a
 * trivial window.__game so they never touch the engine CDN. The egress test
 * asserts that an outbound request to 169.254.169.254 (cloud metadata) is
 * aborted by the route handler.
 *
 * IMPORTANT: importing main.ts must not kick off the BullMQ worker / Redis
 * connection — main.ts only auto-starts when BROWSER_WORKER_NO_AUTOSTART !== '1'.
 */
process.env['BROWSER_WORKER_NO_AUTOSTART'] = '1';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
// Dynamic import so BROWSER_WORKER_NO_AUTOSTART is set *before* main.ts module
// init runs — a static import is hoisted above the assignment and would let the
// BullMQ worker auto-start and try to reach Redis.
type MainModule = typeof import('./main');
let mod: MainModule;
let browser: Browser;

beforeAll(async () => {
  mod = await import('./main');
  browser = await chromium.launch({ headless: true });
}, 60_000);

// Convenience accessors so the test bodies below read naturally.
const ENGINE_CDN_ALLOWLIST = (): MainModule['ENGINE_CDN_ALLOWLIST'] => mod.ENGINE_CDN_ALLOWLIST;
const isRequestAllowed: MainModule['isRequestAllowed'] = (u) => mod.isRequestAllowed(u);
const createHardenedContext: MainModule['createHardenedContext'] = (b, vp) =>
  mod.createHardenedContext(b, vp);
const runRuntimeVerify: MainModule['runRuntimeVerify'] = (b, d) => mod.runRuntimeVerify(b, d);
const withHardTimeout: MainModule['withHardTimeout'] = (fn, ms, label) =>
  mod.withHardTimeout(fn, ms, label);
const assertBrowserAlive: MainModule['assertBrowserAlive'] = (b) => mod.assertBrowserAlive(b);

afterAll(async () => {
  if (browser !== undefined) await browser.close();
});

describe('isRequestAllowed (egress policy unit)', () => {
  it('allows the pinned engine CDN host only', () => {
    expect(ENGINE_CDN_ALLOWLIST().has('cdn.jsdelivr.net')).toBe(true);
    expect(isRequestAllowed('https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js')).toBe(
      true,
    );
  });

  it('allows data: and blob: URLs', () => {
    expect(isRequestAllowed('data:text/html,<h1>hi</h1>')).toBe(true);
    expect(isRequestAllowed('blob:https://example.com/abc')).toBe(true);
  });

  it('allows about:blank inline navigation', () => {
    expect(isRequestAllowed('about:blank')).toBe(true);
  });

  it('BLOCKS the cloud metadata endpoint 169.254.169.254', () => {
    expect(isRequestAllowed('http://169.254.169.254/latest/meta-data/')).toBe(false);
  });

  it('BLOCKS RFC1918 + loopback', () => {
    expect(isRequestAllowed('http://10.0.0.5/secret')).toBe(false);
    expect(isRequestAllowed('http://192.168.1.1/admin')).toBe(false);
    expect(isRequestAllowed('http://172.16.0.1/')).toBe(false);
    expect(isRequestAllowed('http://127.0.0.1:6379/')).toBe(false);
    expect(isRequestAllowed('http://localhost:8080/')).toBe(false);
  });

  it('BLOCKS arbitrary origins and exotic schemes', () => {
    expect(isRequestAllowed('https://evil.example.com/exfil')).toBe(false);
    expect(isRequestAllowed('https://unpkg.com/three')).toBe(false);
    expect(isRequestAllowed('file:///etc/passwd')).toBe(false);
    expect(isRequestAllowed('ftp://attacker/x')).toBe(false);
    expect(isRequestAllowed('ws://127.0.0.1/')).toBe(false);
    expect(isRequestAllowed('not a url')).toBe(false);
  });
});

describe('assertBrowserAlive (crash safety)', () => {
  it('throws a clear error when the browser is undefined', () => {
    expect(() => assertBrowserAlive(undefined)).toThrow(/not connected/);
  });

  it('passes for a live connected browser', () => {
    expect(() => assertBrowserAlive(browser)).not.toThrow();
  });
});

describe('withHardTimeout (resource guard)', () => {
  it('rejects work that exceeds the wall-clock ceiling', async () => {
    await expect(
      withHardTimeout(() => new Promise<void>(() => {}), 50, 'forkbomb'),
    ).rejects.toThrow(/exceeded hard timeout/);
  });

  it('returns the value when work finishes in time', async () => {
    await expect(withHardTimeout(async () => 42, 1000, 'fast')).resolves.toBe(42);
  });
});

describe('runRuntimeVerify (real Chromium)', () => {
  it('(a) reports hasGameContract=true when window.__game is present', async () => {
    const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>
      <script>
        window.__game = { debug: { snapshot() { return { ok: true }; } } };
      </script>
    </body></html>`;
    const result = await runRuntimeVerify(browser, {
      kind: 'runtime-verify',
      htmlContent: html,
      bootTimeoutMs: 5_000,
    });
    expect(result.hasGameContract).toBe(true);
    expect(result.fatalErrors).toEqual([]);
  }, 30_000);

  it('(b) reports hasGameContract=false when there is no __game within boot timeout', async () => {
    const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>
      <p>just a plain page, no game contract</p>
    </body></html>`;
    const result = await runRuntimeVerify(browser, {
      kind: 'runtime-verify',
      htmlContent: html,
      bootTimeoutMs: 1_500,
    });
    expect(result.hasGameContract).toBe(false);
  }, 30_000);

  it('(c) captures a thrown error on load in fatalErrors', async () => {
    const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>
      <script>
        throw new Error('boot blew up: PLAYFORGE_TEST_THROW');
      </script>
    </body></html>`;
    const result = await runRuntimeVerify(browser, {
      kind: 'runtime-verify',
      htmlContent: html,
      bootTimeoutMs: 1_500,
    });
    expect(result.hasGameContract).toBe(false);
    expect(result.fatalErrors.some((m) => m.includes('PLAYFORGE_TEST_THROW'))).toBe(true);
  }, 30_000);

  it('(d) EGRESS: blocks an SSRF attempt to the cloud metadata endpoint', async () => {
    // Hostile game code tries to read 169.254.169.254 and report whether the
    // fetch succeeded. The egress lockdown must abort the request, so the fetch
    // rejects — and runRuntimeVerify must record the URL in blockedRequests.
    const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>
      <script>
        window.__exfilSucceeded = null;
        fetch('http://169.254.169.254/latest/meta-data/')
          .then(() => { window.__exfilSucceeded = true; })
          .catch(() => { window.__exfilSucceeded = false; });
        // Also try an image-tag SSRF to an RFC1918 host.
        const img = new Image();
        img.src = 'http://10.0.0.5/exfil.png';
        // Provide a valid game contract so boot completes quickly.
        window.__game = { debug: { snapshot() { return {}; } } };
      </script>
    </body></html>`;
    const result = await runRuntimeVerify(browser, {
      kind: 'runtime-verify',
      htmlContent: html,
      bootTimeoutMs: 5_000,
    });
    // The metadata SSRF must have been aborted by the route handler.
    expect(
      result.blockedRequests.some((u) => u.includes('169.254.169.254')),
    ).toBe(true);
    expect(
      result.blockedRequests.some((u) => u.includes('10.0.0.5')),
    ).toBe(true);
  }, 30_000);
});

describe('createHardenedContext (no permissions)', () => {
  it('creates a context and an egress log, and blocks a disallowed image request', async () => {
    const { context, egress } = await createHardenedContext(browser, { width: 320, height: 240 });
    try {
      const page = await context.newPage();
      await page.setContent(
        `<img src="http://192.168.1.50/track.png">`,
        { waitUntil: 'domcontentloaded', timeout: 3_000 },
      );
      // Give the image request a beat to be intercepted.
      await page.waitForTimeout(300);
      expect(egress.blocked.some((u) => u.includes('192.168.1.50'))).toBe(true);
    } finally {
      await context.close();
    }
  }, 30_000);
});
