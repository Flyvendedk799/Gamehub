/**
 * In-process browser-jobs port for the no-Redis ServerHoster deployment.
 *
 * Normally the agent's runtime-verify + `playtest_game` gates round-trip over a
 * `browser-jobs` BullMQ queue to a dedicated, hardened browser-worker pool
 * (services/browser-worker). On ServerHoster the API runs generation in-process
 * with no Redis/worker, so that boundary doesn't exist and the gates were DARK —
 * games shipped on static lint alone, skipping Phase 1.6's boot-and-repair loop.
 *
 * This adapter restores the gates by owning a BrowserPool IN THIS PROCESS and
 * calling the SAME hardened runner the worker uses (runJob → runRuntimeVerify /
 * runPlaytest). Untrusted game code still executes ONLY inside a headless
 * Chromium CHILD process with the egress lockdown + `permissions: []` + per-job
 * wall-clock timeout — the isolation boundary is the browser process, not the
 * Node process, so co-locating the orchestration in the API is acceptable for a
 * local single-tenant deployment.
 *
 * Degrades gracefully: if Chromium can't launch (not installed), every call
 * returns null and the run falls back to static-lint-only `done`, exactly as
 * before — logged ONCE so the operator knows to install the browser.
 */
import type {
  BrowserJobData,
  BrowserPool as BrowserPoolInstance,
  PlaytestResult,
  RuntimeVerifyResult,
} from '../../browser-worker/src/main';
import type {
  BrowserJobsPort,
  PlaytestVerdict,
  RuntimeVerifyVerdict,
} from '../../worker/src/run-generation';

// The agent-side step type, derived from the port interface so this module
// needs no direct @playforge/agent-core dependency (the API doesn't import it).
type PlaytestSteps = Parameters<BrowserJobsPort['playtest']>[1];

// Loaded LAZILY via dynamic import: the API pays the Playwright import cost only
// when a run actually needs verification, and we set BROWSER_WORKER_NO_AUTOSTART
// first so the module's BullMQ consumer `main()` doesn't boot (it would try to
// connect to Redis). A type-only static import above stays fully erased.
type BrowserWorkerModule = typeof import('../../browser-worker/src/main');

export interface InProcessBrowserJobs extends BrowserJobsPort {
  /** Tear down the shared Chromium on graceful shutdown. */
  close(): Promise<void>;
}

export function makeInProcessBrowserJobs(): InProcessBrowserJobs {
  let mod: BrowserWorkerModule | undefined;
  let pool: BrowserPoolInstance | undefined;
  let disabled = false; // set once a launch/import failure is seen — fail fast after
  let warned = false;

  const ensure = async (): Promise<{
    mod: BrowserWorkerModule;
    pool: BrowserPoolInstance;
  } | null> => {
    if (disabled) return null;
    try {
      if (mod === undefined) {
        process.env['BROWSER_WORKER_NO_AUTOSTART'] = '1';
        mod = await import('../../browser-worker/src/main');
      }
      if (pool === undefined) {
        pool = new mod.BrowserPool({ readRss: mod.readProcessRss });
        await pool.acquire(); // surface a Chromium launch failure now, not per-call
      }
      return { mod, pool };
    } catch (err) {
      disabled = true;
      if (!warned) {
        warned = true;
        console.warn(
          '[in-process-browser] Chromium unavailable — playtest/repair disabled, games ' +
            'ship on static lint only. Enable with: ' +
            'pnpm --filter @playforge/browser-worker install-browsers. Cause:',
          err instanceof Error ? err.message : err,
        );
      }
      return null;
    }
  };

  const run = async <T>(data: BrowserJobData): Promise<T | null> => {
    const ready = await ensure();
    if (ready === null) return null;
    try {
      const browser = await ready.pool.acquire();
      try {
        return (await ready.mod.runJob(browser, data)) as T;
      } finally {
        ready.pool.noteJobDone();
      }
    } catch (err) {
      // A single bad artifact (hung boot, crash) is a no-verdict, not a fatal —
      // the agent's `done` falls back to static lint for this attempt.
      console.warn(
        `[in-process-browser] ${data.kind} produced no verdict:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  };

  return {
    async runtimeVerify(htmlContent: string): Promise<RuntimeVerifyVerdict | null> {
      const result = await run<RuntimeVerifyResult>({ kind: 'runtime-verify', htmlContent });
      if (result === null) return null;
      return {
        hasGameContract: result.hasGameContract,
        fatalErrors: result.fatalErrors,
        juiceScore: result.juiceScore,
      };
    },
    async playtest(htmlContent: string, steps: PlaytestSteps): Promise<PlaytestVerdict | null> {
      const result = await run<PlaytestResult>({
        kind: 'playtest',
        htmlContent,
        steps: [...steps] as NonNullable<BrowserJobData['steps']>,
      });
      if (result === null) return null;
      return {
        hasGameContract: result.hasGameContract,
        hasDebugContract: result.hasDebugContract,
        baselineSnapshot: result.baselineSnapshot,
        steps: result.steps,
        bootErrors: result.bootErrors,
      };
    },
    async close(): Promise<void> {
      if (pool !== undefined) await pool.close();
    },
  };
}
