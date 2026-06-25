/**
 * Thin wrapper to enqueue browser-worker jobs from the API.
 * Used for thumbnail capture on publish and smoke-test on publish.
 */
import { Queue } from 'bullmq';

/** One synthetic-input step in a playtest plan. Kept structurally identical to
 *  the browser-worker `PlaytestStep` union so the job payload round-trips. */
export type PlaytestStep =
  | { kind: 'key'; code: string; frames?: number }
  | { kind: 'mouseMove'; x: number; y: number }
  | { kind: 'mouseDown'; button?: number }
  | { kind: 'mouseUp'; button?: number }
  | { kind: 'wait'; frames: number };

export interface BrowserJobData {
  kind: 'runtime-verify' | 'playtest' | 'thumbnail';
  htmlContent: string;
  viewport?: { width: number; height: number };
  bootTimeoutMs?: number;
  steps?: PlaytestStep[];
}

export interface RuntimeVerifyResult {
  hasGameContract: boolean;
  fatalErrors: string[];
  bootedIn: number;
}

export interface ThumbnailResult {
  pngBase64: string;
  width: number;
  height: number;
}

/** Per-step snapshot trace row — mirrors the browser-worker result. */
export interface PlaytestStepResult {
  step: PlaytestStep;
  snapshotAfter: unknown;
  errors: string[];
}

/** Result of a playtest job — mirrors the browser-worker `PlaytestResult`. */
export interface PlaytestResult {
  hasGameContract: boolean;
  hasDebugContract: boolean;
  baselineSnapshot: unknown;
  steps: PlaytestStepResult[];
  bootErrors: string[];
  blockedRequests: string[];
}

export class BrowserJobQueue {
  private readonly queue: Queue<BrowserJobData>;

  constructor(redisUrl: string) {
    const u = new URL(redisUrl);
    this.queue = new Queue('browser-jobs', {
      connection: { host: u.hostname, port: Number(u.port) || 6379 },
    });
  }

  async enqueueThumbnail(htmlContent: string): Promise<string> {
    const job = await this.queue.add(
      'thumbnail',
      {
        kind: 'thumbnail',
        htmlContent,
        viewport: { width: 1280, height: 720 },
        bootTimeoutMs: 8000,
      },
      { removeOnComplete: 10, removeOnFail: 10 },
    );
    return job.id ?? 'unknown';
  }

  async enqueueRuntimeVerify(htmlContent: string): Promise<string> {
    const job = await this.queue.add(
      'runtime-verify',
      { kind: 'runtime-verify', htmlContent, bootTimeoutMs: 10_000 },
      { removeOnComplete: 10, removeOnFail: 10 },
    );
    return job.id ?? 'unknown';
  }

  async enqueuePlaytest(htmlContent: string, steps: PlaytestStep[]): Promise<string> {
    const job = await this.queue.add(
      'playtest',
      { kind: 'playtest', htmlContent, steps, bootTimeoutMs: 10_000 },
      { removeOnComplete: 10, removeOnFail: 10 },
    );
    return job.id ?? 'unknown';
  }

  async waitForResult<T>(jobId: string, timeoutMs = 30_000): Promise<T | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const job = await this.queue.getJob(jobId);
      if (!job) return null;
      const state = await job.getState();
      if (state === 'completed') {
        return job.returnvalue as T;
      }
      if (state === 'failed') return null;
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  }
}
