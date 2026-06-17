/**
 * Browser-worker — Playwright Chromium pool for game verification.
 *
 * Consumes `browser-jobs` BullMQ queue. Supports three job kinds:
 *   runtime-verify: boot the game HTML, check window.__game is present,
 *                   return any fatal console errors.
 *   playtest:       drive synthetic input, snapshot debug state.
 *   thumbnail:      take a 640×360 screenshot, return as base64 PNG.
 *
 * SECURITY (IMPROVEMENT_BACKLOG #3 — highest-risk surface):
 *   Each job boots UNTRUSTED, AI-generated game HTML inside Chromium. Hostile
 *   game code must not be able to exfiltrate data or pivot (SSRF) from inside
 *   the renderer. Every per-job context therefore:
 *     - installs a default-DENY network route: every request is ABORTED unless
 *       its host is on the pinned engine-CDN allowlist (the same hosts the
 *       runtime adapters pin), or it is a data:/blob: URL, or it is the
 *       document's own about:blank/inline navigation. This blocks
 *       169.254.169.254 (cloud metadata), RFC1918 / loopback ranges, and any
 *       arbitrary origin.
 *     - is created with `permissions: []` so geolocation/camera/clipboard/etc
 *       are all denied.
 *     - is ALWAYS closed in a finally, and the whole job runs under a hard
 *       wall-clock timeout (Promise.race) so an infinite-sync-loop / canvas
 *       fork-bomb cannot pin a worker slot forever.
 *   NOTE: we deliberately do NOT use context.setOffline — that would also kill
 *   the engine CDN that runtime-verify legitimately needs to boot __game.
 *
 * Each job runs in a fresh Playwright context per job for isolation. A shared
 * browser instance is reused across jobs for lower startup cost. Per-tenant
 * browser isolation (one browser per tenant, not just one context) is a
 * follow-up — see #3 in the backlog.
 *
 * Required env vars:
 *   REDIS_URL   Redis connection string
 *
 * Optional:
 *   BLOB_DIR            local blob store for storing thumbnail blobs
 *   DATABASE_URL        Postgres — for writing thumbnail_url back to published_games
 *   WORKER_CONCURRENCY  parallel browser jobs (default: 2)
 */
import { chromium, type Browser, type BrowserContext, type Route } from 'playwright';
import { Worker } from 'bullmq';

function parseRedisUrl(url: string): { host: string; port: number } {
  try {
    const u = new URL(url);
    return { host: u.hostname, port: Number(u.port) || 6379 };
  } catch {
    return { host: '127.0.0.1', port: 6379 };
  }
}

/**
 * Pinned engine-CDN hostnames. Discovered by reading the runtime adapters:
 *   packages/runtime/src/engines/three.ts  → cdn.jsdelivr.net (three ESM + addons)
 *   packages/runtime/src/engines/phaser.ts → cdn.jsdelivr.net (phaser ESM)
 * Both adapters pin exclusively to cdn.jsdelivr.net. Only these exact hosts may
 * be reached from inside an untrusted game context — everything else is aborted.
 */
export const ENGINE_CDN_ALLOWLIST: ReadonlySet<string> = new Set(['cdn.jsdelivr.net']);

/** Hard ceiling on total wall-clock time for any single job, in ms. */
export const JOB_HARD_TIMEOUT_MS = 30_000;

/**
 * Decide whether an outbound request from inside an untrusted game context is
 * permitted. Default-DENY: only allow data:/blob: URLs, the inline document
 * itself (about:blank), and the pinned engine CDN host(s).
 *
 * Exported for direct unit testing of the policy without a live browser.
 */
export function isRequestAllowed(rawUrl: string): boolean {
  // about:blank / about:srcdoc — the document's own inline navigation.
  if (rawUrl === 'about:blank' || rawUrl.startsWith('about:')) return true;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    // Unparseable URL — deny by default.
    return false;
  }

  const scheme = parsed.protocol.toLowerCase();

  // Inline payloads carry no network egress: always safe.
  if (scheme === 'data:' || scheme === 'blob:') return true;

  // Only http(s) may reach the network, and only to the pinned CDN host(s).
  // This blocks 169.254.169.254, RFC1918, loopback, and any arbitrary origin,
  // as well as exotic schemes (file:, ftp:, ws:, gopher:, …).
  if (scheme === 'http:' || scheme === 'https:') {
    return ENGINE_CDN_ALLOWLIST.has(parsed.hostname.toLowerCase());
  }

  return false;
}

/**
 * Counter of aborted (blocked) requests, keyed by URL — used by tests to assert
 * that a given exfiltration/SSRF attempt was blocked.
 */
export interface EgressLog {
  /** URLs that were aborted by the default-deny policy. */
  readonly blocked: string[];
  /** URLs that were allowed through to the network / inline resolution. */
  readonly allowed: string[];
}

/**
 * Install the default-deny network egress policy on a per-job context.
 * Returns an EgressLog the caller can inspect.
 */
export async function installEgressLockdown(context: BrowserContext): Promise<EgressLog> {
  const log: EgressLog = { blocked: [], allowed: [] };
  await context.route('**/*', async (route: Route) => {
    const url = route.request().url();
    if (isRequestAllowed(url)) {
      log.allowed.push(url);
      await route.continue();
    } else {
      log.blocked.push(url);
      await route.abort('blockedbyclient');
    }
  });
  return log;
}

/**
 * Create a hardened, locked-down per-job context: no permissions, default-deny
 * network egress. The returned EgressLog tracks blocked/allowed requests.
 */
export async function createHardenedContext(
  browser: Browser,
  viewport: { width: number; height: number },
): Promise<{ context: BrowserContext; egress: EgressLog }> {
  // permissions: [] denies geolocation/camera/microphone/clipboard/etc.
  const context = await browser.newContext({ viewport, permissions: [] });
  const egress = await installEgressLockdown(context);
  return { context, egress };
}

/**
 * Run an async job under a hard wall-clock ceiling. If the job exceeds the
 * timeout, reject so a hostile infinite loop cannot pin the worker slot. The
 * underlying work still has its context torn down by its own finally block.
 */
export async function withHardTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`[browser-worker] job '${label}' exceeded hard timeout of ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Guard shared-browser access: surface a clear error if the browser has died. */
export function assertBrowserAlive(browser: Browser | undefined): asserts browser is Browser {
  if (browser === undefined || !browser.isConnected()) {
    throw new Error(
      '[browser-worker] shared Chromium is not connected (crashed or not launched). Job cannot run.',
    );
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
  /** URLs blocked by the egress lockdown during this job (for audit/telemetry). */
  blockedRequests: string[];
}

export interface ThumbnailResult {
  /** Base64-encoded PNG screenshot. */
  pngBase64: string;
  width: number;
  height: number;
}

export type BrowserJobResult = RuntimeVerifyResult | ThumbnailResult;

export async function runRuntimeVerify(
  browser: Browser,
  data: BrowserJobData,
): Promise<RuntimeVerifyResult> {
  assertBrowserAlive(browser);
  const { context, egress } = await createHardenedContext(browser, {
    width: 1280,
    height: 720,
  });
  const page = await context.newPage();
  const fatalErrors: string[] = [];
  page.on('pageerror', (err) => {
    fatalErrors.push(err.message);
  });

  const start = Date.now();
  const bootTimeoutMs = data.bootTimeoutMs ?? 10_000;
  // NB: page.waitForFunction does NOT honour its inline `timeout` option for
  // RAF/interval polling in a headless, non-painting page — it falls back to the
  // page default (30s). Set the default explicitly so the no-__game verdict is
  // bounded by bootTimeoutMs, not a runaway 30s. The job-level hard timeout
  // (withHardTimeout) is the backstop.
  page.setDefaultTimeout(bootTimeoutMs);

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
    return { hasGameContract, fatalErrors, bootedIn, blockedRequests: [...egress.blocked] };
  } finally {
    await context.close();
  }
}

export async function runThumbnail(browser: Browser, data: BrowserJobData): Promise<ThumbnailResult> {
  assertBrowserAlive(browser);
  const vp = data.viewport ?? { width: 640, height: 360 };
  const { context } = await createHardenedContext(browser, vp);
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

/**
 * Dispatch a single job. Wrapped in the hard wall-clock timeout so no hostile
 * payload can pin a worker slot indefinitely.
 */
export async function runJob(browser: Browser, data: BrowserJobData): Promise<BrowserJobResult> {
  return withHardTimeout(
    async () => {
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
    JOB_HARD_TIMEOUT_MS,
    data.kind,
  );
}

async function main(): Promise<void> {
  const redisUrl = process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379';
  const concurrency = Number(process.env['WORKER_CONCURRENCY'] ?? '2');
  const connection = parseRedisUrl(redisUrl);

  let browser: Browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    console.error('[browser-worker] FATAL: Chromium failed to launch:', err);
    throw err;
  }
  console.log('[browser-worker] Chromium launched');

  const worker = new Worker<BrowserJobData, BrowserJobResult>(
    'browser-jobs',
    async (job) => {
      const { data } = job;
      console.log(`[browser-worker] job ${job.id} kind=${data.kind}`);
      // Guard shared-browser death: surface a clear error rather than a cryptic
      // "Target closed" deep inside Playwright.
      assertBrowserAlive(browser);
      return runJob(browser, data);
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

// Only auto-start when run as the entrypoint, not when imported by tests.
if (process.env['BROWSER_WORKER_NO_AUTOSTART'] !== '1') {
  void main();
}
