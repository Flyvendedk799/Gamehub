import { execFileSync } from 'node:child_process';
import { Worker } from 'bullmq';
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
import { type Browser, type BrowserContext, type Page, type Route, chromium } from 'playwright';

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

/**
 * Allowed path PREFIXES on the engine CDN. A host-only allowlist is too broad:
 * cdn.jsdelivr.net proxies ALL npm packages AND arbitrary GitHub repos
 * (`/gh/<user>/<repo>@<ref>/…`), so a hostile game could load attacker-authored
 * code from `cdn.jsdelivr.net/gh/attacker/x@main/p.js`. Pin to the two engine
 * packages the runtime adapters actually request. (CSP M3)
 */
export const ENGINE_CDN_PATH_PREFIXES: readonly string[] = ['/npm/three@', '/npm/phaser@'];

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

  // Only http(s) may reach the network, and only the pinned engine packages on
  // the pinned CDN host. This blocks 169.254.169.254, RFC1918, loopback, any
  // arbitrary origin, exotic schemes (file:, ftp:, ws:, gopher:, …), AND the
  // jsdelivr /gh/ + arbitrary-npm proxy paths an attacker could load code from.
  if (scheme === 'http:' || scheme === 'https:') {
    if (!ENGINE_CDN_ALLOWLIST.has(parsed.hostname.toLowerCase())) return false;
    return ENGINE_CDN_PATH_PREFIXES.some((prefix) => parsed.pathname.startsWith(prefix));
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
  // tsx/esbuild (keepNames, on by default) rewrites named functions to
  // `__name(fn, "…")`. When a `page.evaluate` callback's source is serialized to
  // run INSIDE the page, that helper reference travels with it but `__name` is
  // undefined in the browser → "ReferenceError: __name is not defined", which
  // breaks tickFrames / measureJuice / playtest whenever the worker runs under
  // tsx (its default `start` script, and the API's in-process pool). Define a
  // harmless identity shim on every document so the helper resolves. Passed as a
  // STRING so esbuild does not transform (and re-inject `__name` into) it.
  await context.addInitScript(
    'globalThis.__name = globalThis.__name || function (f) { return f; };',
  );
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
    return this.browser?.isConnected() ?? false;
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
    if (b?.isConnected()) {
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
  /**
   * Phase 5.5 — deterministic JUICE / density floor. A bounded, non-negative
   * integer that measures how much VISIBLE MOTION the artifact produces over a
   * short window of forced frames: the count of changed canvas pixels sampled
   * between two forced paints plus the animation-activity churn (RAF callbacks
   * driven + tween/particle/active-emitter hints surfaced by the game). A static
   * no-animation "game" scores ~0; a juicy one scores high. The eval
   * `requireJuice` floor gates on this. 0 when no canvas / never booted.
   */
  juiceScore: number;
  /**
   * Premium-completeness — did the game render ANYTHING visible? `false` ONLY when
   * we reliably read a 2D canvas that is essentially a single uniform colour (or
   * fully transparent) across two captures — i.e. it booted but draws nothing (the
   * ultimate "disappoint"). Defaults `true` and ABSTAINS (stays true) for a WebGL
   * canvas (an unreadable cleared buffer ≠ blank), a tainted canvas, or no canvas —
   * so it can NEVER false-flag a game we couldn't reliably inspect.
   */
  renderedNonBlank: boolean;
}

/** Phase 5.5 — hard ceiling on the juice score so a pathological canvas /
 *  fork-bomb cannot return an unbounded number. Pixel-delta + churn are each
 *  clamped well under this; the sum is clamped here as a final guard. */
export const JUICE_SCORE_MAX = 100_000;

/** Phase 5.5 — number of RAF frames we FORCE between the two canvas samples.
 *  Headless Chromium throttles/﻿skips RAF on a non-painting page, so we drive
 *  frames explicitly (tickFrames) AND force a paint via a 0-area screenshot so
 *  the canvas compositor actually advances before we read pixels back. Small
 *  and bounded — the per-job hard timeout is the backstop. */
export const JUICE_FRAME_WINDOW = 24;

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

/**
 * Phase 5.5 — measure a deterministic JUICE / density score for the booted
 * artifact. Returns 0 when there is no canvas or sampling fails.
 *
 * CRITICAL build note: headless Chromium does NOT paint a normal RAF loop —
 * `requestAnimationFrame` is throttled/coalesced on a page that is never
 * composited, so motion is invisible to a naive `toDataURL` diff. We therefore
 * FORCE rendering explicitly:
 *   1. tick a bounded window of RAF frames (tickFrames) to advance game state,
 *   2. force a real paint via a 0-area `page.screenshot()` between the two
 *      canvas samples so the compositor flushes the canvas backing store,
 * then diff the two captured canvas data URLs pixel-by-pixel (downsampled) and
 * add the in-page animation-activity churn (RAF callbacks fired during the
 * window + tween/particle/active-emitter hints the game surfaces). The whole
 * thing is bounded by JUICE_SCORE_MAX and runs under the per-job hard timeout.
 *
 * The motion delta is computed in-page from two `canvas.toDataURL()` captures
 * (no pixel bytes cross the CDP boundary — only the final integer does), and a
 * forced `page.screenshot()` sits between the two captures to guarantee the
 * canvas actually advanced a frame on a non-painting headless page.
 */
async function measureJuice(page: Page): Promise<number> {
  try {
    // Snapshot 1: install a RAF counter + capture the first canvas frame as a
    // DOWNSAMPLED PIXEL BUFFER (drawImage → getImageData), not a PNG data URL.
    // The old toDataURL→new Image()→img.decode() roundtrip failed in headless on
    // most runs, firing a hard-coded magnitude=96 fallback that clustered nearly
    // every game at ~96 — a broken instrument. Reading pixels directly off an
    // offscreen canvas has no decode step to fail. The buffer lives on
    // window.__juice (page memory) so snapshot 2 can diff against it in-page.
    const ok = await page.evaluate(() => {
      const w = window as Window & {
        __juice?: { rafCount: number; beforePixels?: Uint8ClampedArray };
        requestAnimationFrame: typeof requestAnimationFrame;
      };
      const canvas = document.querySelector('canvas');
      if (!(canvas instanceof HTMLCanvasElement)) return false;
      const state: { rafCount: number; beforePixels?: Uint8ClampedArray } = { rafCount: 0 };
      // Wrap RAF so we can count how many callbacks the game schedules during
      // the forced window — a static page schedules ~0, a juicy one schedules
      // one per frame (or many, for layered tween/particle systems).
      const orig = w.requestAnimationFrame.bind(w);
      w.requestAnimationFrame = (cb: FrameRequestCallback): number => {
        state.rafCount += 1;
        return orig(cb);
      };
      const SAMPLE = 64;
      const off = document.createElement('canvas');
      off.width = SAMPLE;
      off.height = SAMPLE;
      const octx = off.getContext('2d');
      if (octx !== null) {
        try {
          octx.drawImage(canvas, 0, 0, SAMPLE, SAMPLE);
          state.beforePixels = octx.getImageData(0, 0, SAMPLE, SAMPLE).data;
        } catch {
          // Tainted canvas (cross-origin draw) — pixel diff unavailable; churn
          // alone carries the score. `state.beforePixels` simply stays unset.
        }
      }
      w.__juice = state;
      return true;
    });
    if (!ok) return 0;

    // FORCE a paint + advance frames. tickFrames drives RAF; the 0-clip
    // screenshot flushes the compositor so the canvas backing store actually
    // updates on a non-painting headless page.
    await tickFrames(page, JUICE_FRAME_WINDOW);
    try {
      await page.screenshot({ clip: { x: 0, y: 0, width: 1, height: 1 }, type: 'png' });
    } catch {
      // Screenshot can fail on a detached page — frames were still ticked.
    }
    await tickFrames(page, JUICE_FRAME_WINDOW);

    // Snapshot 2: diff the AFTER frame against `beforePixels`, restore RAF, and
    // fold in the animation-activity churn the game exposed.
    // Graduated juice. Two prior formulas clustered scores: the first at ~385
    // (rafChurn*4 dominated); the second at ~96 (the toDataURL→img.decode()
    // roundtrip failed in headless on most runs, firing a hard-coded magnitude=96
    // fallback). Now: DIRECT drawImage→getImageData pixel buffers (no decode to
    // fail), pixel MAGNITUDE + spatial SPREAD (a full-screen explosion >> a cursor
    // blink), particles/tweens the game exposes, and rafChurn demoted to a modest
    // "the loop runs" BASE — so the score actually RANKS games across a wide range.
    const score = await page.evaluate(
      async ({ max, frameWindow }: { max: number; frameWindow: number }) => {
        const w = window as Window & {
          __juice?: { rafCount: number; beforePixels?: Uint8ClampedArray };
          __game?: {
            debug?: {
              snapshot?: () => unknown;
              particleCount?: number;
              activeTweens?: number;
            };
          };
        };
        const state = w.__juice;
        if (state === undefined) return 0;

        const SAMPLE = 64;
        // Capture the AFTER frame the same way as before — direct drawImage →
        // getImageData, no PNG/decode roundtrip (that was the broken path).
        const after = (() => {
          const canvas = document.querySelector('canvas');
          if (!(canvas instanceof HTMLCanvasElement)) return undefined;
          const off = document.createElement('canvas');
          off.width = SAMPLE;
          off.height = SAMPLE;
          const octx = off.getContext('2d');
          if (octx === null) return undefined;
          try {
            octx.drawImage(canvas, 0, 0, SAMPLE, SAMPLE);
            return octx.getImageData(0, 0, SAMPLE, SAMPLE).data;
          } catch {
            return undefined;
          }
        })();

        // (1) Motion: magnitude + spread between the two forced frames, compared
        // DIRECTLY on the two pixel buffers (no decode → no failure fallback).
        // Per-cell channel delta = magnitude; which screen QUADRANTS changed = spread.
        const before = state.beforePixels;
        let magnitude = 0;
        let changedCells = 0;
        const quadrants = [false, false, false, false];
        if (before !== undefined && after !== undefined && before.length === after.length) {
          const cells = before.length / 4;
          for (let c = 0; c < cells; c += 1) {
            const i = c * 4;
            const d =
              Math.abs(before[i]! - after[i]!) +
              Math.abs(before[i + 1]! - after[i + 1]!) +
              Math.abs(before[i + 2]! - after[i + 2]!);
            if (d > 24) {
              changedCells += 1;
              magnitude += d;
              const row = Math.floor(c / SAMPLE);
              const col = c % SAMPLE;
              quadrants[(row < SAMPLE / 2 ? 0 : 2) + (col < SAMPLE / 2 ? 0 : 1)] = true;
            }
          }
        }
        const quadrantSpread = quadrants.filter(Boolean).length; // 0..4
        const motion = Math.round(magnitude / 6) + changedCells * 4 + quadrantSpread * 60;

        // (2) Richness the game EXPOSES + a modest churn base proving the loop runs.
        const rafChurn = Math.min(state.rafCount, frameWindow * 4);
        const dbg = w.__game?.debug;
        // Number.isFinite (not typeof === 'number') — a game exposing NaN/Infinity
        // would otherwise propagate to juiceScore = NaN (review M-juice).
        const particles = Number.isFinite(dbg?.particleCount) ? (dbg?.particleCount ?? 0) : 0;
        const tweens = Number.isFinite(dbg?.activeTweens) ? (dbg?.activeTweens ?? 0) : 0;
        const richness = Math.min(particles, 5000) * 2 + Math.min(tweens, 1000) * 4;
        const base = rafChurn; // was rafChurn*4 — demoted from dominant term to a floor

        const raw = motion + richness + base;
        return Number.isFinite(raw) ? Math.max(0, Math.min(max, Math.round(raw))) : 0;
      },
      { max: JUICE_SCORE_MAX, frameWindow: JUICE_FRAME_WINDOW },
    );
    return score;
  } catch {
    // Any failure during sampling ⇒ no juice evidence (treat as 0, never throw).
    return 0;
  }
}

/** Grace window after window.__game appears, to let an async scene-setup crash
 *  (which fires a tick after the synchronous shim sets __game) surface as a
 *  pageerror/console error before we report the boot verdict. */
const BOOT_ERROR_GRACE_MS = 600;

/** The unambiguous fatal-JS-exception class. Matching console.error text here is
 *  a real crash (a TypeError/ReferenceError), not a benign game log like
 *  console.error('player died'). Conservative on purpose. */
const FATAL_CONSOLE_PATTERNS: readonly RegExp[] = [
  /is not a function/,
  /is not defined/,
  /Cannot read propert(?:y|ies) of (?:undefined|null)/,
  /Cannot access .+ before initialization/,
  /is not a constructor/,
  /Maximum call stack size exceeded/,
  /(?:undefined|null) is not an object/,
];

/**
 * Premium-completeness — detect a game that booted but renders a BLANK canvas.
 * Deliberately conservative to NEVER false-flag (a false positive burns a repair
 * round on a working game):
 *   - 2D context ONLY. A WebGL canvas's getContext('2d') is null; we can't read a
 *     WebGL frame reliably without preserveDrawingBuffer (a cleared buffer reads
 *     blank but isn't), so we ABSTAIN → not blank.
 *   - "blank" = the sampled frame is essentially ONE colour everywhere (per-channel
 *     range < UNIFORM_EPSILON) OR fully transparent (nothing drawn). ANY real
 *     content — a gradient backdrop, title text, a sprite — spikes the range well
 *     past the threshold.
 *   - tainted / no-canvas / read failure → ABSTAIN (not blank).
 * Returns true when the frame is confirmed blank, false otherwise (incl. abstain).
 */
async function sampleCanvasBlank(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      const UNIFORM_EPSILON = 8;
      const SAMPLE = 96;
      const canvas = document.querySelector('canvas');
      if (!(canvas instanceof HTMLCanvasElement)) return false; // abstain
      // 2D only — a WebGL canvas returns null here, and we must not guess at it.
      if (canvas.getContext('2d') === null) return false; // abstain (WebGL)
      const off = document.createElement('canvas');
      off.width = SAMPLE;
      off.height = SAMPLE;
      const octx = off.getContext('2d');
      if (octx === null) return false;
      try {
        octx.drawImage(canvas, 0, 0, SAMPLE, SAMPLE);
        const d = octx.getImageData(0, 0, SAMPLE, SAMPLE).data;
        let rMin = 255;
        let rMax = 0;
        let gMin = 255;
        let gMax = 0;
        let bMin = 255;
        let bMax = 0;
        let aMax = 0;
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i] ?? 0;
          const g = d[i + 1] ?? 0;
          const b = d[i + 2] ?? 0;
          const a = d[i + 3] ?? 0;
          if (r < rMin) rMin = r;
          if (r > rMax) rMax = r;
          if (g < gMin) gMin = g;
          if (g > gMax) gMax = g;
          if (b < bMin) bMin = b;
          if (b > bMax) bMax = b;
          if (a > aMax) aMax = a;
        }
        // Fully transparent → nothing drawn. Otherwise blank iff one flat colour.
        if (aMax === 0) return true;
        const range = Math.max(rMax - rMin, gMax - gMin, bMax - bMin);
        return range < UNIFORM_EPSILON;
      } catch {
        return false; // tainted canvas → abstain
      }
    });
  } catch {
    return false; // page gone → abstain
  }
}

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
  // Some engines (Phaser) catch a scene-setup exception internally and re-log it
  // as console.error instead of letting it bubble as a pageerror — so the game
  // "boots" (window.__game is set by the shim) but the scene is dead. Capture the
  // unambiguous fatal-exception class from the console too, so that crash isn't
  // shipped as a working game (the broken idle: `…setParentContainer is not a function`).
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (FATAL_CONSOLE_PATTERNS.some((re) => re.test(text))) {
      fatalErrors.push(`Uncaught error during boot: ${text}`);
    }
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
    await page.setContent(data.htmlContent, {
      timeout: bootTimeoutMs,
      waitUntil: 'domcontentloaded',
    });
    // Wait up to bootTimeoutMs for window.__game to appear.
    let hasGameContract = false;
    try {
      await page.waitForFunction(
        () => typeof (window as Window & { __game?: unknown }).__game === 'object',
        {
          timeout: bootTimeoutMs,
        },
      );
      hasGameContract = true;
    } catch {
      hasGameContract = false;
    }
    const bootedIn = Date.now() - start;
    // Phase 5.5 — measure visible motion / density only once the game booted;
    // a never-booted artifact has no juice to measure (score 0). Best-effort:
    // measureJuice never throws.
    const juiceScore = hasGameContract ? await measureJuice(page) : 0;
    // Robustness — the inline shim sets window.__game synchronously, so
    // waitForFunction resolves BEFORE the engine's async scene create() runs.
    // A crash there fires a tick after we'd otherwise return, and ships as a
    // "booted" game. Give async boot errors a grace window to surface into
    // fatalErrors before we report the verdict.
    if (hasGameContract) {
      await page.waitForTimeout(BOOT_ERROR_GRACE_MS).catch(() => {});
    }
    // Premium-completeness — blank-render check. Only after the game booted +
    // rendered (measureJuice drove frames). Require TWO blank reads, with frames
    // driven between them, so a transient intro/fade can never be flagged — only a
    // PERSISTENTLY uniform 2D canvas (booted-but-draws-nothing) is reported blank.
    let renderedNonBlank = true;
    if (hasGameContract) {
      // Nudge past a Title/Start screen first, so the sample reflects the PLAY state,
      // not a (possibly flat) intro a game draws content only after — the seed's
      // start() listens for pointerdown/Space on window (review residual fix). Harmless
      // if ignored: a game with no start handler simply stays where it was.
      await page
        .evaluate(() => {
          try {
            const c = document.querySelector('canvas');
            for (const target of [window, c].filter(Boolean) as EventTarget[]) {
              target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
              target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            }
            window.dispatchEvent(
              new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true }),
            );
          } catch {
            /* dispatch best-effort */
          }
        })
        .catch(() => {});
      await tickFrames(page, JUICE_FRAME_WINDOW).catch(() => {});
      const blank1 = await sampleCanvasBlank(page);
      if (blank1) {
        await tickFrames(page, JUICE_FRAME_WINDOW).catch(() => {});
        const blank2 = await sampleCanvasBlank(page);
        renderedNonBlank = !blank2;
      }
    }
    return {
      hasGameContract,
      fatalErrors,
      bootedIn,
      blockedRequests: [...egress.blocked],
      juiceScore,
      renderedNonBlank,
    };
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
    await page.setContent(data.htmlContent, {
      timeout: bootTimeoutMs,
      waitUntil: 'domcontentloaded',
    });
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
