import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HOST_COMPLETION_DEFAULT_MS,
  HOST_COMPLETION_LOW_MS,
  HostCompletionTimeoutError,
  hostCompletionTimeoutMs,
  withTimeout,
} from './host-completion.js';

describe('host completion time limits', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('gives routing calls less time than whole-file rewrites', () => {
    expect(hostCompletionTimeoutMs('low')).toBe(HOST_COMPLETION_LOW_MS);
    expect(hostCompletionTimeoutMs('medium')).toBe(HOST_COMPLETION_DEFAULT_MS);
    expect(HOST_COMPLETION_LOW_MS).toBeLessThan(HOST_COMPLETION_DEFAULT_MS);
  });

  it('passes the value through when the call answers in time, and does not abort it', async () => {
    const abort = vi.fn();
    await expect(withTimeout(Promise.resolve('reply'), 1000, abort)).resolves.toBe('reply');
    await vi.advanceTimersByTimeAsync(5000);
    expect(abort).not.toHaveBeenCalled();
  });

  it('rejects and aborts the request when the provider never answers (run 951f7a7a)', async () => {
    const abort = vi.fn();
    const outcome = withTimeout(new Promise<string>(() => {}), 1000, abort);
    const assertion = expect(outcome).rejects.toBeInstanceOf(HostCompletionTimeoutError);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it('surfaces the call own error unchanged', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000, vi.fn())).rejects.toThrow(
      'boom',
    );
  });
});
