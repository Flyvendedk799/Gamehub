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
import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright';
import { Worker } from 'bullmq';
import { execFileSync } from 'node:child_process';

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
 * timeout, reject so a hostile infinite loop cannot pin the worker slot.
 *
 * IMPORTANT (kill-switch — backlog #33c): a `Promise.race` against a timeout
 * only abandons the inner promise — it does NOT cancel the in-flight Playwright
 * call. If the inner work is hung inside `page.waitForFunction` (which can
 * outlive its own inline timeout on a non-painting page), that promise NEVER
 * settles, so its own `finally { context.close() }` never runs and the context
 * leaks for the worker's lifetime. The optional `onTimeout` hook is therefore
 * invoked the instant the deadline fires to FORCE the context closed, which in
 * turn rejects the stuck Playwright call ("Target closed") and lets the inner
 * finally run. `onTimeout` errors are swallowed — teardown must never mask the
 * timeout error.
 */
export async function withHardTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  label: string,
  onTimeout?: () => void | Promise<void>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      if (onTimeout !== undefined) {
        try {
          void Promise.resolve(onTimeout()).catch(() => {});
        } catch {
          // never let cleanup mask the timeout
        }
      }
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

/**
 * Default number of jobs a single Chromium process may serve before it is
 * proactively recycled. A long-lived renderer accumulates state, fragmented
 * heap and potential leaks across tenants; recycling bounds that blast radius.
 */
export const DEFAULT_RECYCLE_AFTER_JOBS = 50;

/**
 * Resident-set ceiling (bytes) above which the browser is recycled even before
 * the job-count threshold is reached. Defends against a slow leak / memory
 * pressure pinning the host. Measured against the Chromium process RSS when a
 * pid is available; skipped otherwise.
 */
export const DEFAULT_RECYCLE_RSS_BYTES = 1_500 * 1024 * 1024; // ~1.5 GiB

/**
 * A freshly launched browser plus, when available, the OS pid of its Chromium
 * process. The public Playwright `Browser` type does not expose a pid, so the
 * launcher surfaces it explicitly to enable memory-pressure recycling.
 */
export interface LaunchedBrowser {
  readonly browser: Browser;
  readonly pid?: number;
}

/** Signature of a function that launches a fresh Chromium. Injectable for tests. */
export type BrowserLauncher = () => Promise<LaunchedBrowser>;

/** Read the resident-set size (bytes) of a process by pid, or undefined. */
export type RssReader = (pid: number) => number | undefined;

/** Default launcher: headless Chromium, surfacing its pid when Playwright exposes one. */
export async function launchChromium(): Promise<LaunchedBrowser> {
  const browser = await chromium.launch({ headless: true });
  // `process()` exists on the Chromium browser at runtime but is absent from the
  // public `Browser` type; read it through a narrow, typed duck-type guard.
  const withProcess = browser as Browser & { process?: () => { pid?: number } | undefined };
  const pid = typeof withProcess.process === 'function' ? withProcess.process()?.pid : undefined;
  return pid === undefined ? { browser } : { browser, pid };
}

export interface BrowserPoolOptions {
  /** How to launch a fresh browser. Defaults to headless Chromium. */
  readonly launch?: BrowserLauncher;
  /** Recycle the browser after this many jobs. */
  readonly recycleAfterJobs?: number;
  /** Recycle if process RSS exceeds this many bytes. */
  readonly recycleRssBytes?: number;
  /** Reads a process RSS; undefined disables memory-pressure recycling. */
  readonly readRss?: RssReader;
}

/**
 * Owns the long-lived shared Chromium and its lifecycle.
 *
 * It guarantees a job always runs against a LIVE browser by:
 *   (a) RECYCLE — relaunching after `recycleAfterJobs` jobs OR when the process
 *       RSS crosses `recycleRssBytes`, so accumulated state/leaks across tenants
 *       cannot pile up in one process for the worker's lifetime.
 *   (b) RELAUNCH-ON-DISCONNECT — a `disconnected` event (crash, OOM-kill, or a
 *       recycle close) marks the current browser dead; the very next
 *       `acquire()` transparently relaunches. A single Chromium death therefore
 *       no longer fails every subsequent job until the worker is restarted.
 *
 * Relaunch is serialized through a single in-flight promise so concurrent jobs
 * don't spawn a thundering herd of browsers.
 */
export class BrowserPool {
  private browser: Browser | undefined;
  private pid: number | undefined;
  private jobsServed = 0;
  private launching: Promise<Browser> | undefined;
  private closed = false;
  /** Total relaunches performed (visible for tests/telemetry). */
  public relaunchCount = 0;

  private readonly launch: BrowserLauncher;
  private readonly recycleAfterJobs: number;
  private readonly recycleRssBytes: number;
  private readonly readRss: RssReader | undefined;

  constructor(opts: BrowserPoolOptions = {}) {
    this.launch = opts.launch ?? launchChromium;
    this.recycleAfterJobs = opts.recycleAfterJobs ?? DEFAULT_RECYCLE_AFTER_JOBS;
    this.recycleRssBytes = opts.recycleRssBytes ?? DEFAULT_RECYCLE_RSS_BYTES;
    this.readRss = opts.readRss;
  }

  /** Number of jobs served by the CURRENT browser instance since last relaunch. */
  public get currentJobCount(): number {
    return this.jobsServed;
  }

  /** True if a live, connected browser is currently held. */
  public get isAlive(): boolean {
    return this.browser !== undefined && this.browser.isConnected();
  }

  /** Wire the disconnected handler so a crash marks the browser dead. */
  private attach(browser: Browser): void {
    browser.on('disconnected', () => {
      // Drop our reference so the next acquire() relaunches. Do NOT relaunch
      // eagerly here — wait until a job actually needs a browser.
      if (this.browser === browser) {
        this.browser = undefined;
        this.pid = undefined;
        this.jobsServed = 0;
      }
    });
  }

  private async relaunch(): Promise<Browser> {
    // Serialize: if a relaunch is already in flight, await it.
    if (this.launching !== undefined) return this.launching;
    const p = (async () => {
      const { browser: fresh, pid } = await this.launch();
      this.attach(fresh);
      this.browser = fresh;
      this.pid = pid;
      this.jobsServed = 0;
      this.relaunchCount += 1;
      return fresh;
    })();
    this.launching = p;
    try {
      return await p;
    } finally {
      this.launching = undefined;
    }
  }

  /** Decide whether the current browser should be recycled before this job. */
  private shouldRecycle(): boolean {
    if (this.jobsServed >= this.recycleAfterJobs) return true;
    if (this.readRss !== undefined && this.pid !== undefined) {
      const rss = this.readRss(this.pid);
      if (rss !== undefined && rss >= this.recycleRssBytes) return true;
    }
    return false;
  }

  /**
   * Acquire a live browser for one job. Relaunches transparently if the current
   * browser is dead/absent (disconnect/crash) or due for recycling.
   */
  public async acquire(): Promise<Browser> {
    if (this.closed) {
      throw new Error('[browser-worker] BrowserPool is closed; cannot acquire a browser.');
    }
    // Relaunch if missing or disconnected (crash path).
    if (this.browser === undefined || !this.browser.isConnected()) {
      return this.relaunch();
    }
    // Proactive recycle (job-count or memory pressure).
    if (this.shouldRecycle()) {
      const stale = this.browser;
      // Detach our reference first so the disconnected handler is a no-op for
      // the explicit close below, then relaunch.
      this.browser = undefined;
      this.pid = undefined;
      this.jobsServed = 0;
      try {
        await stale.close();
      } catch {
        // Already gone — fine.
      }
      return this.relaunch();
    }
    return this.browser;
  }

  /** Record that a job completed against the current browser (drives recycle). */
  public noteJobDone(): void {
    this.jobsServed += 1;
  }

  /** Tear down the pool for graceful shutdown. */
  public async close(): Promise<void> {
    this.closed = true;
    const b = this.browser;
    this.browser = undefined;
    this.pid = undefined;
    if (b !== undefined && b.isConnected()) {
      try {
        await b.close();
      } catch {
        // ignore
      }
    }
  }
}

/** Read a process RSS (bytes) on Linux/macOS via `ps`. Best-effort; sync. */
export function readProcessRss(pid: number): number | undefined {
  try {
    const out = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    const kib = Number(out);
    if (!Number.isFinite(kib) || kib <= 0) return undefined;
    return kib * 1024; // ps reports RSS in KiB.
  } catch {
    return undefined;
  }
}

export type BrowserJobKind = 'runtime-verify' | 'playtest' | 'thumbnail';

/**
 * One synthetic-input step in a playtest plan. Mirrors the agent-side
 * `PlaytestStep` union in `@playforge/agent-core`
 * (packages/core/src/tools/playtest-game.ts). The browser-worker dispatches
 * each step against the booted game, ticking `frames` RAF frames where a
 * frame count applies, and reads `window.__game.debug.snapshot()` before and
 * after every step so a caller can diff input → state.
 *
 * `key`      — hold `code` down for `frames` RAF frames, then release.
 * `mouseMove`— move the pointer to a normalised (0..1) viewport coordinate.
 * `mouseDown`/`mouseUp` — press / release a mouse button (0=left,1=mid,2=right).
 * `wait`     — tick `frames` RAF frames with no input (let physics settle).
 */
export type PlaytestStep =
  | { kind: 'key'; code: string; frames?: number }
  | { kind: 'mouseMove'; x: number; y: number }
  | { kind: 'mouseDown'; button?: number }
  | { kind: 'mouseUp'; button?: number }
  | { kind: 'wait'; frames: number };

export interface BrowserJobData {
  kind: BrowserJobKind;
  /** HTML content string or data URL of the game bundle. */
  htmlContent: string;
  /** For thumbnail jobs: width × height. */
  viewport?: { width: number; height: number };
  /** Boot timeout in ms (default 10000). */
  bootTimeoutMs?: number;
  /** For playtest jobs: the ordered synthetic-input plan to dispatch. */
  steps?: PlaytestStep[];
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

/** The serialised state read back after a single playtest step ran. Maps onto
 *  the agent-side `PlaytestStepResult` (snapshotAfter + per-step errors). */
export interface PlaytestStepResult {
  /** The step that was dispatched (echoed back for trace alignment). */
  step: PlaytestStep;
  /** `window.__game.debug.snapshot()` evaluated AFTER the step ran. `null`
   *  when the game never overrode the default getter (no debug contract) or
   *  the snapshot threw / was unserialisable. */
  snapshotAfter: unknown;
  /** Page errors captured between this step and the previous one. */
  errors: string[];
}

/**
 * Result of a playtest job. Maps cleanly onto the host
 * `PlaytesterOutput` contract in `@playforge/agent-core`:
 *   hasDebugContract  ← `debugContractPresent`
 *   baselineSnapshot  ← `baselineSnapshot`
 *   steps[].snapshotAfter / errors ← per-step snapshots
 *   bootErrors        ← `bootErrors`
 */
export interface PlaytestResult {
  /** True when `window.__game` appeared within the boot timeout. */
  hasGameContract: boolean;
  /** True when the baseline `window.__game.debug.snapshot()` returned a
   *  non-null value — i.e. the game wired a real debug getter. */
  hasDebugContract: boolean;
  /** Snapshot taken once after boot, before the first step ran. */
  baselineSnapshot: unknown;
  /** Per-step snapshot trace, in dispatch order. */
  steps: PlaytestStepResult[];
  /** Errors thrown during load / boot, before the first step ran (includes a
   *  no-__game timeout marker when the game never booted). */
  bootErrors: string[];
  /** URLs blocked by the egress lockdown during this job (audit/telemetry). */
  blockedRequests: string[];
}

export type BrowserJobResult = RuntimeVerifyResult | ThumbnailResult | PlaytestResult;

/**
 * Optional hook invoked with each per-job context the moment it is created, so
 * a deadline kill-switch can force-close a hung context even when the inner
 * Playwright call never settles. See `withHardTimeout` / `runJob`.
 */
export type ContextSink = (context: BrowserContext) => void;

export async function runRuntimeVerify(
  browser: Browser,
  data: BrowserJobData,
  onContext?: ContextSink,
): Promise<RuntimeVerifyResult> {
  assertBrowserAlive(browser);
  const { context, egress } = await createHardenedContext(browser, {
    width: 1280,
    height: 720,
  });
  onContext?.(context);
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

export async function runThumbnail(
  browser: Browser,
  data: BrowserJobData,
  onContext?: ContextSink,
): Promise<ThumbnailResult> {
  assertBrowserAlive(browser);
  const vp = data.viewport ?? { width: 640, height: 360 };
  const { context } = await createHardenedContext(browser, vp);
  onContext?.(context);
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

/** Map the iphone/ipad/desktop viewport hints used elsewhere to a concrete
 *  pixel size. Defaults to a 1280×720 desktop window — large enough that a
 *  normalised mouseMove (x,y in 0..1) lands somewhere sensible. */
const PLAYTEST_VIEWPORT = { width: 1280, height: 720 } as const;

/** Tick N requestAnimationFrame frames inside the page, resolving once they
 *  have all fired. Bounded by a wall-clock fallback so a page that never
 *  paints (headless can throttle RAF) still resolves — the per-job hard
 *  timeout is the ultimate backstop. */
async function tickFrames(page: Page, frames: number): Promise<void> {
  const n = Math.max(1, Math.min(240, Math.floor(frames)));
  await page.evaluate(async (count: number) => {
    await new Promise<void>((resolve) => {
      let remaining = count;
      const fallback = setTimeout(resolve, 50 + count * 20);
      const step = (): void => {
        remaining -= 1;
        if (remaining <= 0) {
          clearTimeout(fallback);
          resolve();
          return;
        }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }, n);
}

/** Read `window.__game.debug.snapshot()` defensively. Returns null when no
 *  debug contract is wired or the getter throws / yields an unserialisable
 *  value (the page-side JSON round-trip guarantees a structured-clonable
 *  result crosses the boundary). */
async function readSnapshot(page: Page): Promise<unknown> {
  try {
    return await page.evaluate(() => {
      const g = (window as Window & { __game?: { debug?: { snapshot?: () => unknown } } }).__game;
      const snap = g?.debug?.snapshot;
      if (typeof snap !== 'function') return null;
      try {
        const value = snap();
        if (value === undefined) return null;
        // Round-trip through JSON so only structured-clonable data crosses the
        // CDP boundary; a snapshot returning a THREE.Vector3 / DOM node would
        // otherwise reject the evaluate call.
        return JSON.parse(JSON.stringify(value)) as unknown;
      } catch {
        return null;
      }
    });
  } catch {
    return null;
  }
}

/**
 * Boot the game HTML in a hardened per-job context, wait for `window.__game`,
 * then dispatch each synthetic-input step — ticking RAF frames and reading
 * `window.__game.debug.snapshot()` before and after — and return the trace.
 *
 * This is the real implementation behind `playtest_game`: it measures input →
 * state so a game that moves +x on KeyD yields an increasing `snapshotAfter.x`,
 * a `rotation.y = -playerAngle` sign error yields a detectably inverted facing,
 * and a throwing boot surfaces in `bootErrors`.
 */
export async function runPlaytest(
  browser: Browser,
  data: BrowserJobData,
  onContext?: ContextSink,
): Promise<PlaytestResult> {
  assertBrowserAlive(browser);
  const { context, egress } = await createHardenedContext(browser, { ...PLAYTEST_VIEWPORT });
  onContext?.(context);
  const page = await context.newPage();

  // Page errors land here; we drain into per-step buckets as we go so each
  // snapshot trace row carries only the errors that fired during its step.
  const pendingErrors: string[] = [];
  page.on('pageerror', (err) => {
    pendingErrors.push(err.message);
  });
  const drainErrors = (): string[] => pendingErrors.splice(0, pendingErrors.length);

  const steps: PlaytestStep[] = data.steps ?? [];
  const bootTimeoutMs = data.bootTimeoutMs ?? 10_000;
  page.setDefaultTimeout(bootTimeoutMs);

  const stepResults: PlaytestStepResult[] = [];
  const bootErrors: string[] = [];

  try {
    await page.setContent(data.htmlContent, {
      timeout: bootTimeoutMs,
      waitUntil: 'domcontentloaded',
    });

    // Wait for window.__game to appear. A no-__game game can still be played
    // against (the steps run, snapshots stay null) — but we record the failure
    // in bootErrors so the caller can distinguish "booted, no debug contract"
    // from "never booted".
    let hasGameContract = false;
    try {
      await page.waitForFunction(
        () => typeof (window as Window & { __game?: unknown }).__game === 'object',
        { timeout: bootTimeoutMs },
      );
      hasGameContract = true;
    } catch {
      hasGameContract = false;
      bootErrors.push(`window.__game did not appear within ${bootTimeoutMs}ms`);
    }

    // Capture any boot-time page errors that fired before the first step.
    bootErrors.push(...drainErrors());

    const baselineSnapshot = await readSnapshot(page);
    const hasDebugContract = baselineSnapshot !== null;

    for (const step of steps) {
      switch (step.kind) {
        case 'key': {
          const frames = step.frames ?? 15;
          await page.keyboard.down(step.code);
          await tickFrames(page, frames);
          await page.keyboard.up(step.code);
          break;
        }
        case 'mouseMove': {
          const x = Math.max(0, Math.min(1, step.x)) * PLAYTEST_VIEWPORT.width;
          const y = Math.max(0, Math.min(1, step.y)) * PLAYTEST_VIEWPORT.height;
          await page.mouse.move(x, y);
          await tickFrames(page, 2);
          break;
        }
        case 'mouseDown': {
          await page.mouse.down({ button: mouseButton(step.button) });
          await tickFrames(page, 2);
          break;
        }
        case 'mouseUp': {
          await page.mouse.up({ button: mouseButton(step.button) });
          await tickFrames(page, 2);
          break;
        }
        case 'wait': {
          await tickFrames(page, step.frames);
          break;
        }
      }

      const snapshotAfter = await readSnapshot(page);
      stepResults.push({ step, snapshotAfter, errors: drainErrors() });
    }

    return {
      hasGameContract,
      hasDebugContract,
      baselineSnapshot,
      steps: stepResults,
      bootErrors,
      blockedRequests: [...egress.blocked],
    };
  } catch (err) {
    // A failure during setContent / step dispatch (e.g. an SSRF-blocked import
    // that wedges the document) surfaces as a boot error rather than a thrown
    // job — the caller wants the partial trace, not a 500.
    bootErrors.push(err instanceof Error ? err.message : String(err));
    bootErrors.push(...drainErrors());
    return {
      hasGameContract: false,
      hasDebugContract: false,
      baselineSnapshot: null,
      steps: stepResults,
      bootErrors,
      blockedRequests: [...egress.blocked],
    };
  } finally {
    await context.close();
  }
}

/** Map a DOM MouseEvent.button index (0=left,1=middle,2=right) to the
 *  Playwright button name. Defaults to left. */
function mouseButton(button: number | undefined): 'left' | 'middle' | 'right' {
  if (button === 1) return 'middle';
  if (button === 2) return 'right';
  return 'left';
}

/**
 * Dispatch a single job. Wrapped in the hard wall-clock timeout so no hostile
 * payload can pin a worker slot indefinitely.
 *
 * Backlog #33c — kill switch: every per-job context is tracked here. When the
 * hard deadline fires, `onTimeout` force-closes any still-open context. That
 * unblocks a hung `waitForFunction`/`waitForTimeout` (the in-flight Playwright
 * call rejects with "Target closed"), so the job's own finally runs and the
 * context never leaks even when the inner promise would otherwise never settle.
 */
export async function runJob(browser: Browser, data: BrowserJobData): Promise<BrowserJobResult> {
  const liveContexts = new Set<BrowserContext>();
  const track: ContextSink = (ctx) => {
    liveContexts.add(ctx);
    // Self-prune once the context closes normally so the kill switch is a no-op.
    ctx.on('close', () => liveContexts.delete(ctx));
  };
  const killSwitch = async (): Promise<void> => {
    await Promise.all(
      [...liveContexts].map((ctx) =>
        ctx.close().catch(() => {
          /* already gone */
        }),
      ),
    );
  };

  return withHardTimeout(
    async () => {
      if (data.kind === 'runtime-verify') {
        return runRuntimeVerify(browser, data, track);
      }
      if (data.kind === 'thumbnail') {
        return runThumbnail(browser, data, track);
      }
      // playtest — boot, drive synthetic input, snapshot debug state per step.
      return runPlaytest(browser, data, track);
    },
    JOB_HARD_TIMEOUT_MS,
    data.kind,
    killSwitch,
  );
}

async function main(): Promise<void> {
  const redisUrl = process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379';
  const concurrency = Number(process.env['WORKER_CONCURRENCY'] ?? '2');
  const connection = parseRedisUrl(redisUrl);

  const pool = new BrowserPool({ readRss: readProcessRss });
  try {
    // Eagerly warm one browser so the first job doesn't pay the launch cost and
    // so a launch failure surfaces at boot rather than per-job.
    await pool.acquire();
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
      // Acquire a guaranteed-live browser: transparently relaunches after a
      // crash/disconnect (#33b) and recycles after N jobs / memory pressure
      // (#33a). A single Chromium death no longer fails every subsequent job.
      const browser = await pool.acquire();
      try {
        return await runJob(browser, data);
      } finally {
        // Count the job whether it succeeded or failed; drives the recycle gate.
        pool.noteJobDone();
      }
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
      await pool.close();
      process.exit(0);
    });
  }

  console.log(`[playforge-browser-worker] listening (concurrency=${concurrency})`);
}

// Only auto-start when run as the entrypoint, not when imported by tests.
if (process.env['BROWSER_WORKER_NO_AUTOSTART'] !== '1') {
  void main();
}
