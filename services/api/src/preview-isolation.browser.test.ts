import { InMemoryEventBus } from '@playforge/bus';
import { InMemoryBlobStore, SnapshotStore } from '@playforge/storage';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { HeaderAuthenticator } from './auth';
import { InMemoryProjectRepo } from './repo';
import { InMemoryRunRepo } from './run-repo';
import { buildServer } from './server';

it('Chromium enforces opaque origin, storage and control-plane isolation on the served preview', async () => {
  const repo = new InMemoryProjectRepo();
  const store = new SnapshotStore(new InMemoryBlobStore());
  const project = await repo.create({ ownerId: 'alice', name: 'Hostile game', engine: 'canvas2d' });
  const { manifestKey } = await store.write([
    {
      path: 'index.html',
      bytes: Buffer.from(`
    <html><body><canvas></canvas><script>
      window.__game = { debug: {} };
      (async () => {
        const result = {};
        try { result.parent = parent.localStorage.getItem('pf_token'); } catch { result.parent = 'blocked'; }
        try { result.storage = localStorage.getItem('pf_token'); } catch { result.storage = 'blocked'; }
        try { await fetch('https://app.example.test/v1/projects'); result.api = 'allowed'; } catch { result.api = 'blocked'; }
        parent.postMessage({ type: 'isolation-result', result }, '*');
      })();
    </script></body></html>`),
    },
  ]);
  await repo.setCurrentSnapshot(project.id, 'snapshot', manifestKey);
  const app = buildServer({
    repo,
    store,
    auth: new HeaderAuthenticator(),
    bus: new InMemoryEventBus(),
    runRepo: new InMemoryRunRepo(),
    enqueue: async () => {},
    appBaseUrl: 'https://app.example.test',
    gameBaseUrl: 'https://games.example.test',
  });
  const session = await app.inject({
    method: 'POST',
    url: `/v1/projects/${project.id}/preview-session`,
    headers: { 'x-user-id': 'alice' },
  });
  const gameUrl: string = session.json().url;
  const browserServer = await chromium.launchServer({
    host: '127.0.0.1',
    headless: true,
    ...(process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE']
      ? { executablePath: process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] }
      : {}),
  });
  const browser = await chromium.connect(browserServer.wsEndpoint());
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    let apiRequests = 0;
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === 'app.example.test' && url.pathname === '/') {
        await route.fulfill({
          contentType: 'text/html',
          body: `<script>
          localStorage.setItem('pf_token', 'application-secret');
          addEventListener('message', event => {
            if (event.source === document.querySelector('iframe').contentWindow && event.data.type === 'isolation-result')
              document.title = JSON.stringify({ ...event.data.result, origin: event.origin });
          });</script><iframe sandbox="allow-scripts allow-pointer-lock" src="${gameUrl}"></iframe>`,
        });
      } else if (url.hostname === 'app.example.test') {
        apiRequests++;
        await route.abort();
      } else {
        const response = await app.inject({
          method: 'GET',
          url: url.pathname,
          headers: { host: url.host },
        });
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(response.headers)) {
          if (typeof value === 'string') headers[key] = value;
        }
        await route.fulfill({ status: response.statusCode, headers, body: response.body });
      }
    });
    await page.goto('https://app.example.test', { waitUntil: 'domcontentloaded', timeout: 8000 });
    await expect.poll(() => page.title()).toContain('blocked');
    expect(JSON.parse(await page.title())).toEqual({
      parent: 'blocked',
      storage: 'blocked',
      api: 'blocked',
      origin: 'null',
    });
    expect(apiRequests).toBe(0);
    expect(await page.evaluate(() => localStorage.getItem('pf_token'))).toBe('application-secret');
    // The response CSP also isolates a direct tab, without an iframe sandbox.
    await page.goto(gameUrl, { waitUntil: 'domcontentloaded', timeout: 8000 });
    expect(
      await page.evaluate(() => {
        try {
          localStorage.setItem('probe', 'x');
          return 'allowed';
        } catch {
          return 'blocked';
        }
      }),
    ).toBe('blocked');
  } finally {
    await context.close();
    await browser.close();
    await browserServer.kill();
    await app.close();
  }
}, 60_000);
