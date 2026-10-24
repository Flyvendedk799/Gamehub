/**
 * Time limits for the host's own model calls (the first draft, import repair, the loop-free edit
 * and its summary). They run outside the agent loop, so the loop's wall-clock budget never covered
 * them: run 951f7a7a started a host repair edit, the provider stream stalled, and the run sat on
 * "Editing main.js" for more than 16 minutes with nothing to cancel it.
 */

/** A routing / summary call with low reasoning: seconds of output. */
export const HOST_COMPLETION_LOW_MS = 120_000;
/** A rewrite of whole files (medium reasoning, up to 60k output tokens). */
export const HOST_COMPLETION_DEFAULT_MS = 480_000;

export function hostCompletionTimeoutMs(reasoning: string): number {
  return reasoning === 'low' ? HOST_COMPLETION_LOW_MS : HOST_COMPLETION_DEFAULT_MS;
}

export class HostCompletionTimeoutError extends Error {
  constructor(ms: number) {
    super(`the model did not answer within ${Math.round(ms / 1000)}s`);
    this.name = 'HostCompletionTimeoutError';
  }
}

/**
 * Settle with `promise`, or reject after `ms` and run `onTimeout` (to abort the underlying
 * request, so it does not keep running and billing in the background).
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        onTimeout();
      } finally {
        reject(new HostCompletionTimeoutError(ms));
      }
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
