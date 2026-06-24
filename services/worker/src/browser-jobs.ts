/**
 * Out-of-process browser-jobs client for the generation worker.
 *
 * Phase-1b (#1.4) — the generation worker must NOT boot untrusted game code
 * in-process. Instead it round-trips runtime-verify + playtest requests over a
 * second BullMQ queue (`browser-jobs`) to the dedicated browser-worker pool,
 * exactly like the API's `BrowserJobQueue` does for the publish smoke-test and
 * thumbnail capture. This keeps the gen/credits worker free of any Playwright /
 * Chromium dependency and preserves the isolation boundary: untrusted code only
 * ever executes inside the hardened, egress-locked browser-worker context.
 *
 * This is a deliberate (small) duplicate of services/api/src/browser-queue.ts —
 * the worker does not depend on @playforge/api, and the payload/result shapes
 * are owned by the browser-worker contract, so each consumer keeps its own thin
 * client rather than introducing a cross-service package dependency.
 */
import { Queue } from 'bullmq';

/** Synthetic-input step — structurally identical to the browser-worker union. */
export type PlaytestStep =
  | { kind: 'key'; code: string; frames?: number }
  | { kind: 'mouseMove'; x: number; y: number }
  | { kind: 'mouseDown'; button?: number }
  | { kind: 'mouseUp'; button?: number }
  | { kind: 'wait'; frames: number };

interface BrowserJobData {
  kind: 'runtime-verify' | 'playtest' | 'thumbnail';
  htmlContent: string;
  bootTimeoutMs?: number;
  steps?: PlaytestStep[];
}

export interface RuntimeVerifyResult {
  hasGameContract: boolean;
  fatalErrors: string[];
  bootedIn: number;
  blockedRequests?: string[];
  juiceScore?: number;
  /** Premium-completeness — false ONLY when a 2D canvas is confirmed persistently blank. */
  renderedNonBlank?: boolean;
}

export interface PlaytestStepResult {
  step: PlaytestStep;
  snapshotAfter: unknown;
  errors: string[];
}

export interface PlaytestResult {
  hasGameContract: boolean;
  hasDebugContract: boolean;
  baselineSnapshot: unknown;
  steps: PlaytestStepResult[];
  bootErrors: string[];
  blockedRequests: string[];
}

/**
 * Thin request/response client over the `browser-jobs` BullMQ queue. Enqueues a
 * job, then polls for its terminal state — the same proven pattern the API uses
 * (`waitForResult`). Returns `null` on timeout / failure / missing job so the
 * caller can degrade gracefully (a missing verdict is treated as "no evidence",
 * never as a hard failure of the whole generation).
 */
export class BrowserJobsClient {
  private readonly queue: Queue<BrowserJobData>;

  constructor(redisUrl: string) {
    const u = new URL(redisUrl);
    this.queue = new Queue('browser-jobs', {
      connection: { host: u.hostname, port: Number(u.port) || 6379 },
    });
  }

  async enqueueRuntimeVerify(htmlContent: string): Promise<string> {
    const job = await this.queue.add(
      'runtime-verify',
      { kind: 'runtime-verify', htmlContent, bootTimeoutMs: 10_000 },
      { removeOnComplete: 20, removeOnFail: 20 },
    );
    return job.id ?? 'unknown';
  }

  async enqueuePlaytest(htmlContent: string, steps: PlaytestStep[]): Promise<string> {
    const job = await this.queue.add(
      'playtest',
      { kind: 'playtest', htmlContent, steps, bootTimeoutMs: 10_000 },
      { removeOnComplete: 20, removeOnFail: 20 },
    );
    return job.id ?? 'unknown';
  }

  async waitForResult<T>(jobId: string, timeoutMs = 30_000): Promise<T | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const job = await this.queue.getJob(jobId);
      if (!job) return null;
      const state = await job.getState();
      if (state === 'completed') return job.returnvalue as T;
      if (state === 'failed') return null;
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}
