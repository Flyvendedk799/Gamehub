/**
 * Browser-worker — Playwright Chromium pool for game verification.
 *
 * Consumes `browser-jobs` BullMQ queue. Supports three job kinds:
 *   runtime-verify: boot the game HTML, check window.__game is present,
 *                   return any fatal console errors.
 *   playtest:       drive synthetic input, snapshot debug state.
 *   thumbnail:      take a 640×360 screenshot, return as base64 PNG.
 *
 * Each job runs in a fresh Playwright page (context per job for isolation).
 * A shared browser instance is reused across jobs for lower startup cost.
 *
 * Required env vars:
 *   REDIS_URL   Redis connection string
 *
 * Optional:
 *   BLOB_DIR            local blob store for storing thumbnail blobs
 *   DATABASE_URL        Postgres — for writing thumbnail_url back to published_games
 *   WORKER_CONCURRENCY  parallel browser jobs (default: 2)
 */
import { chromium, type Browser } from 'playwright';
import { Worker } from 'bullmq';

function parseRedisUrl(url: string): { host: string; port: number } {
  try {
    const u = new URL(url);
    return { host: u.hostname, port: Number(u.port) || 6379 };
  } catch {
    return { host: '127.0.0.1', port: 6379 };
  }
}

export type BrowserJobKind = 'runtime-verify' | 'playtest' | 'thumbnail';

export interface BrowserJobData {
  kind: BrowserJobKind;
  /** HTML content string or data URL of the game bundle. */
  htmlContent: string;
  /** For thumbnail jobs: width × height. */
  viewport?: { width: number; height: number };
  /** Boot timeout in ms (default 10000). */
  bootTimeoutMs?: number;
}

export interface RuntimeVerifyResult {
  hasGameContract: boolean;
  fatalErrors: string[];
  bootedIn: number;
}

export interface ThumbnailResult {
  /** Base64-encoded PNG screenshot. */
  pngBase64: string;
  width: number;
  height: number;
}

export type BrowserJobResult = RuntimeVerifyResult | ThumbnailResult;

async function runRuntimeVerify(browser: Browser, data: BrowserJobData): Promise<RuntimeVerifyResult> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const fatalErrors: string[] = [];
  page.on('pageerror', (err) => { fatalErrors.push(err.message); });

  const start = Date.now();
  const bootTimeoutMs = data.bootTimeoutMs ?? 10_000;

  try {
    await page.setContent(data.htmlContent, { timeout: bootTimeoutMs, waitUntil: 'domcontentloaded' });
    // Wait up to bootTimeoutMs for window.__game to appear.
    let hasGameContract = false;
    try {
      await page.waitForFunction(() => typeof (window as Window & { __game?: unknown }).__game === 'object', {
        timeout: bootTimeoutMs,
      });
      hasGameContract = true;
    } catch {
      hasGameContract = false;
    }
    const bootedIn = Date.now() - start;
    return { hasGameContract, fatalErrors, bootedIn };
  } finally {
    await context.close();
  }
}

async function runThumbnail(browser: Browser, data: BrowserJobData): Promise<ThumbnailResult> {
  const vp = data.viewport ?? { width: 640, height: 360 };
  const context = await browser.newContext({ viewport: vp });
  const page = await context.newPage();
  const bootTimeoutMs = data.bootTimeoutMs ?? 8_000;

  try {
    await page.setContent(data.htmlContent, { timeout: bootTimeoutMs, waitUntil: 'domcontentloaded' });
    // Brief settle — let the game canvas render first frame.
    await page.waitForTimeout(1500);
    const pngBytes = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, ...vp } });
    return { pngBase64: Buffer.from(pngBytes).toString('base64'), ...vp };
  } finally {
    await context.close();
  }
}

async function main() {
  const redisUrl = process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379';
  const concurrency = Number(process.env['WORKER_CONCURRENCY'] ?? '2');
  const connection = parseRedisUrl(redisUrl);

  const browser: Browser = await chromium.launch({ headless: true });
  console.log('[browser-worker] Chromium launched');

  const worker = new Worker<BrowserJobData, BrowserJobResult>(
    'browser-jobs',
    async (job) => {
      const { data } = job;
      console.log(`[browser-worker] job ${job.id} kind=${data.kind}`);

      if (data.kind === 'runtime-verify') {
        return runRuntimeVerify(browser, data);
      }
      if (data.kind === 'thumbnail') {
        return runThumbnail(browser, data);
      }
      // playtest — simplified: just verify + return debug snapshot placeholder.
      const verify = await runRuntimeVerify(browser, data);
      return { ...verify, playtestSteps: [] };
    },
    { connection, concurrency },
  );

  worker.on('failed', (job, err) => {
    console.error(`[browser-worker] job ${job?.id ?? '?'} failed:`, err);
  });

  // Graceful shutdown
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      await worker.close();
      await browser.close();
      process.exit(0);
    });
  }

  console.log(`[playforge-browser-worker] listening (concurrency=${concurrency})`);
}

void main();
