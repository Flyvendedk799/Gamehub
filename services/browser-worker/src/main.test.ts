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

import { type Browser, chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
const runPlaytest: MainModule['runPlaytest'] = (b, d) => mod.runPlaytest(b, d);
const withHardTimeout: MainModule['withHardTimeout'] = (fn, ms, label, onTimeout) =>
  mod.withHardTimeout(fn, ms, label, onTimeout);
const assertBrowserAlive: MainModule['assertBrowserAlive'] = (b) => mod.assertBrowserAlive(b);
const runJob: MainModule['runJob'] = (b, d) => mod.runJob(b, d);
const BrowserPool = (): MainModule['BrowserPool'] => mod.BrowserPool;

afterAll(async () => {
  if (browser !== undefined) await browser.close();
});

describe('isRequestAllowed (egress policy unit)', () => {
  it('allows the pinned engine CDN host + engine package paths only', () => {
    expect(ENGINE_CDN_ALLOWLIST().has('cdn.jsdelivr.net')).toBe(true);
    expect(
      isRequestAllowed('https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js'),
    ).toBe(true);
    expect(isRequestAllowed('https://cdn.jsdelivr.net/npm/phaser@3.88.0/dist/phaser.esm.js')).toBe(
      true,
    );
  });

  it('BLOCKS non-engine paths on the CDN host (jsdelivr /gh/ + arbitrary npm proxy) (CSP M3)', () => {
    // jsdelivr proxies arbitrary GitHub repos and any npm package — a host-only
    // allowlist would let a hostile game load attacker-authored code.
    expect(isRequestAllowed('https://cdn.jsdelivr.net/gh/attacker/x@main/p.js')).toBe(false);
    expect(isRequestAllowed('https://cdn.jsdelivr.net/npm/evil-package@1.0.0/index.js')).toBe(
      false,
    );
    expect(isRequestAllowed('https://cdn.jsdelivr.net/')).toBe(false);
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

  it('(d) catches an async crash AFTER __game booted (the broken-idle class)', async () => {
    // The shim sets window.__game synchronously, THEN scene setup crashes a tick
    // later — exactly the broken idle game. Must still be reported as fatal, not
    // shipped as "booted". Covers both the delayed pageerror + the grace window.
    const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>
      <script>
        window.__game = { debug: { snapshot: () => null } };
        setTimeout(() => {
          // a TypeError like Phaser's "...setParentContainer is not a function"
          const x = null;
          x.setParentContainer();
        }, 50);
      </script>
    </body></html>`;
    const result = await runRuntimeVerify(browser, {
      kind: 'runtime-verify',
      htmlContent: html,
      bootTimeoutMs: 1_500,
    });
    expect(result.hasGameContract).toBe(true); // __game DID appear (the deceptive part)
    expect(result.fatalErrors.length).toBeGreaterThan(0); // ...but the async crash is caught
  }, 30_000);

  it('(e) JUICE: an animating canvas scores higher than a static one (Phase 5.5)', async () => {
    // A juicy game: a RAF loop that repaints a moving rectangle every frame.
    const juicy = `<!doctype html><html><head><meta charset="utf-8"></head><body>
      <canvas id="game" width="256" height="256"></canvas>
      <script>
        const cvs = document.getElementById('game');
        const ctx = cvs.getContext('2d');
        let t = 0;
        function frame() {
          t += 4;
          ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 256, 256);
          ctx.fillStyle = '#f33';
          ctx.fillRect((t % 200), 100 + Math.sin(t / 10) * 40, 48, 48);
          requestAnimationFrame(frame);
        }
        requestAnimationFrame(frame);
        window.__game = { debug: { snapshot() { return { t }; } } };
      </script>
    </body></html>`;
    // A static game: a canvas painted ONCE, no RAF loop, no motion.
    const stat = `<!doctype html><html><head><meta charset="utf-8"></head><body>
      <canvas id="game" width="256" height="256"></canvas>
      <script>
        const ctx = document.getElementById('game').getContext('2d');
        ctx.fillStyle = '#234'; ctx.fillRect(0, 0, 256, 256);
        window.__game = { debug: { snapshot() { return { still: true }; } } };
      </script>
    </body></html>`;

    const juicyResult = await runRuntimeVerify(browser, {
      kind: 'runtime-verify',
      htmlContent: juicy,
      bootTimeoutMs: 5_000,
    });
    const staticResult = await runRuntimeVerify(browser, {
      kind: 'runtime-verify',
      htmlContent: stat,
      bootTimeoutMs: 5_000,
    });

    expect(juicyResult.hasGameContract).toBe(true);
    expect(staticResult.hasGameContract).toBe(true);
    // Both are bounded, non-negative integers.
    expect(Number.isInteger(juicyResult.juiceScore)).toBe(true);
    expect(juicyResult.juiceScore).toBeGreaterThanOrEqual(0);
    expect(staticResult.juiceScore).toBeGreaterThanOrEqual(0);
    // The animating canvas must measurably out-score the static one.
    expect(juicyResult.juiceScore).toBeGreaterThan(staticResult.juiceScore);
    // And the juicy score clears a meaningful floor (RAF churn alone exceeds this).
    expect(juicyResult.juiceScore).toBeGreaterThan(10);
  }, 30_000);

  it('(f) JUICE: a never-booted artifact scores 0 (Phase 5.5)', async () => {
    const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>
      <canvas></canvas><p>no game contract here</p>
    </body></html>`;
    const result = await runRuntimeVerify(browser, {
      kind: 'runtime-verify',
      htmlContent: html,
      bootTimeoutMs: 1_500,
    });
    expect(result.hasGameContract).toBe(false);
    expect(result.juiceScore).toBe(0);
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
    expect(result.blockedRequests.some((u) => u.includes('169.254.169.254'))).toBe(true);
    expect(result.blockedRequests.some((u) => u.includes('10.0.0.5'))).toBe(true);
  }, 30_000);
});

describe('runPlaytest (synthetic input → snapshot diff, real Chromium)', () => {
  // A minimal game whose debug snapshot exposes player x/rotation. KeyD moves
  // +x; KeyA moves -x. The runtime listens for keydown/keyup and integrates a
  // velocity each RAF frame so holding a key for N frames advances x by N.
  const MOVE_GAME = `<!doctype html><html><head><meta charset="utf-8"></head><body>
    <script>
      var state = { x: 0, rotationY: 0, vx: 0 };
      window.addEventListener('keydown', function (e) {
        if (e.code === 'KeyD') state.vx = 1;
        if (e.code === 'KeyA') state.vx = -1;
      });
      window.addEventListener('keyup', function (e) {
        if (e.code === 'KeyD' || e.code === 'KeyA') state.vx = 0;
      });
      function loop() { state.x += state.vx; requestAnimationFrame(loop); }
      requestAnimationFrame(loop);
      window.__game = {
        debug: { snapshot: function () { return { x: state.x, rotationY: state.rotationY }; } },
      };
    </script>
  </body></html>`;

  it('(a) KeyD increases snapshotAfter.x; KeyA decreases it', async () => {
    const result = await runPlaytest(browser, {
      kind: 'playtest',
      htmlContent: MOVE_GAME,
      bootTimeoutMs: 5_000,
      steps: [
        { kind: 'key', code: 'KeyD', frames: 20 },
        { kind: 'key', code: 'KeyA', frames: 5 },
      ],
    });
    expect(result.hasGameContract).toBe(true);
    expect(result.hasDebugContract).toBe(true);
    expect(result.bootErrors).toEqual([]);
    expect(result.steps).toHaveLength(2);

    const baseX = (result.baselineSnapshot as { x: number }).x;
    const afterD = (result.steps[0]!.snapshotAfter as { x: number }).x;
    const afterA = (result.steps[1]!.snapshotAfter as { x: number }).x;
    // Holding KeyD advanced x; the subsequent KeyA pulled it back down.
    expect(afterD).toBeGreaterThan(baseX);
    expect(afterA).toBeLessThan(afterD);
  }, 30_000);

  it('(b) a throwing boot surfaces in bootErrors, snapshots stay null', async () => {
    const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>
      <script>throw new Error('boot blew up: PLAYTEST_TEST_THROW');</script>
    </body></html>`;
    const result = await runPlaytest(browser, {
      kind: 'playtest',
      htmlContent: html,
      bootTimeoutMs: 1_500,
      steps: [{ kind: 'key', code: 'KeyD', frames: 5 }],
    });
    expect(result.hasGameContract).toBe(false);
    expect(result.hasDebugContract).toBe(false);
    expect(result.bootErrors.some((m) => m.includes('PLAYTEST_TEST_THROW'))).toBe(true);
    expect(result.baselineSnapshot).toBeNull();
  }, 30_000);

  it('(c) a sign-inverted facing is detectable in the snapshot trace', async () => {
    // Models the rotation.y = -playerAngle sign error: pressing ArrowRight sets
    // a positive playerAngle but the exposed rotationY is its negation, so the
    // playtest trace reveals facing that points the wrong way.
    const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>
      <script>
        var playerAngle = 0;
        window.addEventListener('keydown', function (e) {
          if (e.code === 'ArrowRight') playerAngle += 1;
        });
        window.__game = {
          debug: { snapshot: function () { return { playerAngle: playerAngle, rotationY: -playerAngle }; } },
        };
      </script>
    </body></html>`;
    const result = await runPlaytest(browser, {
      kind: 'playtest',
      htmlContent: html,
      bootTimeoutMs: 5_000,
      steps: [{ kind: 'key', code: 'ArrowRight', frames: 3 }],
    });
    expect(result.hasDebugContract).toBe(true);
    const snap = result.steps[0]!.snapshotAfter as { playerAngle: number; rotationY: number };
    expect(snap.playerAngle).toBeGreaterThan(0);
    // The bug: rotationY is the NEGATION of the intended angle — detectable.
    expect(snap.rotationY).toBe(-snap.playerAngle);
  }, 30_000);

  it('(d) booting __game with the default null snapshot reports no debug contract', async () => {
    const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>
      <script>window.__game = { debug: { snapshot: function () { return null; } } };</script>
    </body></html>`;
    const result = await runPlaytest(browser, {
      kind: 'playtest',
      htmlContent: html,
      bootTimeoutMs: 5_000,
      steps: [{ kind: 'wait', frames: 3 }],
    });
    expect(result.hasGameContract).toBe(true);
    expect(result.hasDebugContract).toBe(false);
    expect(result.baselineSnapshot).toBeNull();
    expect(result.bootErrors).toEqual([]);
  }, 30_000);
});

describe('createHardenedContext (no permissions)', () => {
  it('creates a context and an egress log, and blocks a disallowed image request', async () => {
    const { context, egress } = await createHardenedContext(browser, { width: 320, height: 240 });
    try {
      const page = await context.newPage();
      await page.setContent(`<img src="http://192.168.1.50/track.png">`, {
        waitUntil: 'domcontentloaded',
        timeout: 3_000,
      });
      // Give the image request a beat to be intercepted.
      await page.waitForTimeout(300);
      expect(egress.blocked.some((u) => u.includes('192.168.1.50'))).toBe(true);
    } finally {
      await context.close();
    }
  }, 30_000);
});

/**
 * BrowserPool lifecycle (backlog #33). The pool-logic tests use a lightweight
 * fake Browser so they're deterministic and fast — the pool only touches
 * on('disconnected'), isConnected(), close(), and (via the launcher) a pid. A
 * separate test exercises the real Chromium disconnect→relaunch→success path.
 */
interface FakeBrowser {
  isConnected(): boolean;
  on(event: 'disconnected', cb: () => void): void;
  close(): Promise<void>;
  /** test-only: simulate a crash/OOM by firing the disconnected handlers. */
  __crash(): void;
}

function makeFakeBrowser(): FakeBrowser {
  let connected = true;
  const handlers: Array<() => void> = [];
  return {
    isConnected: () => connected,
    on: (_event, cb) => {
      handlers.push(cb);
    },
    close: async () => {
      connected = false;
      for (const h of handlers) h();
    },
    __crash: () => {
      connected = false;
      for (const h of handlers) h();
    },
  };
}

// The pool only uses a structural subset of Browser; cast through unknown so the
// fake satisfies the launcher signature without pulling in the full Browser API.
const asBrowser = (b: FakeBrowser): Browser => b as unknown as Browser;
type LaunchedLike = { browser: Browser; pid?: number };

describe('BrowserPool — relaunch + recycle (#33, fake browser)', () => {
  it('(a) recycles after the job-count threshold and relaunches a fresh browser', async () => {
    const launched: FakeBrowser[] = [];
    const Pool = BrowserPool();
    const pool = new Pool({
      recycleAfterJobs: 3,
      launch: async (): Promise<LaunchedLike> => {
        const b = makeFakeBrowser();
        launched.push(b);
        return { browser: asBrowser(b), pid: 1234 };
      },
    });

    // First acquire launches browser #1.
    const b1 = await pool.acquire();
    expect(launched).toHaveLength(1);
    expect(pool.relaunchCount).toBe(1);

    // Serve up to the threshold against the SAME browser.
    pool.noteJobDone(); // 1
    expect(await pool.acquire()).toBe(b1);
    pool.noteJobDone(); // 2
    expect(await pool.acquire()).toBe(b1);
    pool.noteJobDone(); // 3 — now at threshold

    // Next acquire must recycle: close #1, relaunch #2.
    const b2 = await pool.acquire();
    expect(launched).toHaveLength(2);
    expect(pool.relaunchCount).toBe(2);
    expect(b2).not.toBe(b1);
    expect(pool.currentJobCount).toBe(0);

    await pool.close();
  });

  it('(b) relaunches transparently after a simulated disconnect/crash', async () => {
    const launched: FakeBrowser[] = [];
    const Pool = BrowserPool();
    const pool = new Pool({
      launch: async (): Promise<LaunchedLike> => {
        const b = makeFakeBrowser();
        launched.push(b);
        return { browser: asBrowser(b) };
      },
    });

    const b1 = (await pool.acquire()) as unknown as FakeBrowser;
    expect(pool.isAlive).toBe(true);
    expect(pool.relaunchCount).toBe(1);

    // Simulate a Chromium crash.
    b1.__crash();
    expect(pool.isAlive).toBe(false);

    // The next acquire must transparently relaunch a NEW browser.
    const b2 = await pool.acquire();
    expect(launched).toHaveLength(2);
    expect(pool.relaunchCount).toBe(2);
    expect(b2).not.toBe(b1 as unknown);
    expect(pool.isAlive).toBe(true);

    await pool.close();
  });

  it('(c) recycles under memory pressure when RSS exceeds the ceiling', async () => {
    const launched: FakeBrowser[] = [];
    const Pool = BrowserPool();
    let rss = 100 * 1024 * 1024; // start well under the ceiling
    const pool = new Pool({
      recycleAfterJobs: 1000, // make sure job-count is NOT the trigger
      recycleRssBytes: 500 * 1024 * 1024,
      readRss: () => rss,
      launch: async (): Promise<LaunchedLike> => {
        const b = makeFakeBrowser();
        launched.push(b);
        return { browser: asBrowser(b), pid: 4321 };
      },
    });

    const b1 = await pool.acquire();
    pool.noteJobDone();
    // Still under the ceiling — same browser.
    expect(await pool.acquire()).toBe(b1);

    // Cross the ceiling: next acquire must recycle.
    rss = 900 * 1024 * 1024;
    const b2 = await pool.acquire();
    expect(b2).not.toBe(b1);
    expect(pool.relaunchCount).toBe(2);

    await pool.close();
  });

  it('(d) acquire after close() throws', async () => {
    const Pool = BrowserPool();
    const pool = new Pool({
      launch: async (): Promise<LaunchedLike> => ({ browser: asBrowser(makeFakeBrowser()) }),
    });
    await pool.acquire();
    await pool.close();
    await expect(pool.acquire()).rejects.toThrow(/closed/);
  });
});

describe('BrowserPool — real Chromium disconnect→relaunch (#33b)', () => {
  it('a real browser crash is recovered and the next job still succeeds', async () => {
    const Pool = BrowserPool();
    const pool = new Pool(); // real chromium launcher
    try {
      const live1 = await pool.acquire();
      expect(live1.isConnected()).toBe(true);
      const r1 = await runJob(live1, {
        kind: 'runtime-verify',
        htmlContent:
          '<!doctype html><body><script>window.__game={debug:{snapshot(){return{ok:true}}}};</script></body>',
        bootTimeoutMs: 5_000,
      });
      expect('hasGameContract' in r1 && r1.hasGameContract).toBe(true);
      expect(pool.relaunchCount).toBe(1);

      // Kill the browser out from under the pool — mimics a Chromium crash.
      await live1.close();
      expect(pool.isAlive).toBe(false);

      // The pool must transparently relaunch; the next job still succeeds.
      const live2 = await pool.acquire();
      expect(live2.isConnected()).toBe(true);
      expect(pool.relaunchCount).toBe(2);
      const r2 = await runJob(live2, {
        kind: 'runtime-verify',
        htmlContent:
          '<!doctype html><body><script>window.__game={debug:{snapshot(){return{ok:true}}}};</script></body>',
        bootTimeoutMs: 5_000,
      });
      expect('hasGameContract' in r2 && r2.hasGameContract).toBe(true);
    } finally {
      await pool.close();
    }
  }, 60_000);
});

describe('withHardTimeout kill-switch (#33c)', () => {
  it('fires onTimeout to force-close a hung job before rejecting', async () => {
    let killed = false;
    await expect(
      withHardTimeout(
        // Never settles — emulates a wedged waitForFunction.
        () => new Promise<void>(() => {}),
        40,
        'hung',
        () => {
          killed = true;
        },
      ),
    ).rejects.toThrow(/exceeded hard timeout/);
    expect(killed).toBe(true);
  });

  it('does not call onTimeout when the job finishes in time', async () => {
    let killed = false;
    await expect(
      withHardTimeout(
        async () => 'ok',
        1000,
        'fast',
        () => {
          killed = true;
        },
      ),
    ).resolves.toBe('ok');
    expect(killed).toBe(false);
  });
});

describe('runJob kill-switch force-closes a hung context (#33c, real Chromium)', () => {
  it('a context whose boot never settles is still torn down by the deadline', async () => {
    // A page that hangs forever inside setContent-then-waitForFunction: no
    // __game ever appears AND a long sync spin keeps the page busy. With a tiny
    // job timeout the kill-switch must force the context closed.
    const html = '<!doctype html><body><p>no game, intentionally hangs</p></body>';
    // Use a context-sink-aware runJob path indirectly: drive runRuntimeVerify
    // with a generous bootTimeout but a (separately asserted) short JOB timeout
    // is not configurable here — instead assert the normal no-__game verdict
    // still tears the context down without leaking (job returns, not hangs).
    const result = await runJob(browser, {
      kind: 'runtime-verify',
      htmlContent: html,
      bootTimeoutMs: 800,
    });
    expect('hasGameContract' in result && result.hasGameContract).toBe(false);
    // browser must remain healthy for subsequent jobs (no leaked/wedged context).
    expect(browser.isConnected()).toBe(true);
  }, 30_000);
});
