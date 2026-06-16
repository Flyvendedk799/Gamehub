/**
 * Thin wrapper to enqueue browser-worker jobs from the API.
 * Used for thumbnail capture on publish and smoke-test on publish.
 */
import { Queue } from 'bullmq';

export interface BrowserJobData {
  kind: 'runtime-verify' | 'playtest' | 'thumbnail';
  htmlContent: string;
  viewport?: { width: number; height: number };
  bootTimeoutMs?: number;
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
      { kind: 'thumbnail', htmlContent, viewport: { width: 640, height: 360 }, bootTimeoutMs: 8000 },
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
