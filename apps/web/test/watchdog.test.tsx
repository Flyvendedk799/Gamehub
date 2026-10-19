import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RuntimeWatchdogBridge,
  type WatchdogCrashEvent,
} from '../src/components/RuntimeWatchdogBridge';

describe('RuntimeWatchdogBridge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('triggers crash callback when heartbeat times out after 5000ms', () => {
    const onCrash = vi.fn<(crash: WatchdogCrashEvent) => void>();
    const bridge = new RuntimeWatchdogBridge({ onCrash, timeoutMs: 5000 });

    bridge.start();

    // After 4999ms, no crash should have triggered
    vi.advanceTimersByTime(4999);
    expect(onCrash).not.toHaveBeenCalled();

    // After 5000ms total, watchdog heartbeat times out
    vi.advanceTimersByTime(1);
    expect(onCrash).toHaveBeenCalledTimes(1);
    expect(onCrash).toHaveBeenCalledWith(
      expect.objectContaining({
        errorType: 'WATCHDOG_HEARTBEAT_TIMEOUT',
      }),
    );
  });

  it('resets watchdog timer upon receiving periodic GAMEHUB_PREVIEW_HEARTBEAT messages', () => {
    const onCrash = vi.fn<(crash: WatchdogCrashEvent) => void>();
    const bridge = new RuntimeWatchdogBridge({ onCrash, timeoutMs: 5000 });

    bridge.start();

    // Advance 3000ms
    vi.advanceTimersByTime(3000);
    expect(onCrash).not.toHaveBeenCalled();

    // Send heartbeat at 3000ms
    bridge.handleMessage({ type: 'GAMEHUB_PREVIEW_HEARTBEAT' });

    // Advance another 3000ms (6000ms since start, but only 3000ms since last heartbeat)
    vi.advanceTimersByTime(3000);
    expect(onCrash).not.toHaveBeenCalled();

    // Send heartbeat wrapped in MessageEvent data object
    bridge.handleMessage({ data: { type: 'GAMEHUB_PREVIEW_HEARTBEAT' } });

    // Advance another 4000ms (still < 5000ms since last heartbeat)
    vi.advanceTimersByTime(4000);
    expect(onCrash).not.toHaveBeenCalled();

    // Now let 5000ms elapse without a heartbeat
    vi.advanceTimersByTime(5000);
    expect(onCrash).toHaveBeenCalledTimes(1);
    expect(onCrash).toHaveBeenCalledWith(
      expect.objectContaining({
        errorType: 'WATCHDOG_HEARTBEAT_TIMEOUT',
      }),
    );
  });

  it('immediately triggers crash callback upon receiving webglcontextlost / GAMEHUB_PREVIEW_CRASH events', () => {
    const onCrash = vi.fn<(crash: WatchdogCrashEvent) => void>();
    const bridge = new RuntimeWatchdogBridge({ onCrash, timeoutMs: 5000 });

    bridge.start();

    // Immediately handle webglcontextlost
    bridge.handleMessage({
      type: 'webglcontextlost',
      message: 'GPU crashed or context lost',
    });

    expect(onCrash).toHaveBeenCalledTimes(1);
    expect(onCrash).toHaveBeenCalledWith(
      expect.objectContaining({
        errorType: 'WEBGL_CONTEXT_LOST',
        message: 'GPU crashed or context lost',
      }),
    );

    // Reset mock and start again
    onCrash.mockClear();
    bridge.start();

    // Immediately handle GAMEHUB_PREVIEW_CRASH without explicit errorType (defaults to WEBGL_CONTEXT_LOST)
    bridge.handleMessage({
      type: 'GAMEHUB_PREVIEW_CRASH',
      message: 'Uncaught WebGL rendering error',
      stack: 'Error: WebGL error\n  at renderLoop (game.js:42:10)',
    });

    expect(onCrash).toHaveBeenCalledTimes(1);
    expect(onCrash).toHaveBeenCalledWith(
      expect.objectContaining({
        errorType: 'WEBGL_CONTEXT_LOST',
        message: 'Uncaught WebGL rendering error',
        stack: expect.stringContaining('game.js:42:10'),
      }),
    );

    // Also verify GAMEHUB_PREVIEW_CRASH with custom errorType
    onCrash.mockClear();
    bridge.start();

    bridge.handleMessage({
      type: 'GAMEHUB_PREVIEW_CRASH',
      errorType: 'RUNTIME_SYNTAX_ERROR',
      message: 'Syntax error in boot script',
    });

    expect(onCrash).toHaveBeenCalledTimes(1);
    expect(onCrash).toHaveBeenCalledWith(
      expect.objectContaining({
        errorType: 'RUNTIME_SYNTAX_ERROR',
        message: 'Syntax error in boot script',
      }),
    );
  });

  it('allows manual clearTimer and stop to prevent timeouts', () => {
    const onCrash = vi.fn<(crash: WatchdogCrashEvent) => void>();
    const bridge = new RuntimeWatchdogBridge({ onCrash, timeoutMs: 5000 });

    bridge.start();
    vi.advanceTimersByTime(2500);

    bridge.clearTimer();
    vi.advanceTimersByTime(10000);

    expect(onCrash).not.toHaveBeenCalled();
  });
});
