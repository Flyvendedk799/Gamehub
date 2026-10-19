/**
 * RuntimeWatchdogBridge
 *
 * Implements client-side runtime supervision for untrusted AI-generated game code
 * running inside an opaque-origin sandboxed iframe.
 *
 * Specs:
 * - 5000ms default watchdog heartbeat timeout.
 * - Resets watchdog timer upon receiving 'GAMEHUB_PREVIEW_HEARTBEAT'.
 * - Triggers onCrash with errorType 'WATCHDOG_HEARTBEAT_TIMEOUT' on timeout.
 * - Immediately triggers onCrash with errorType 'WEBGL_CONTEXT_LOST' upon
 *   receiving 'webglcontextlost' or 'GAMEHUB_PREVIEW_CRASH'.
 * - Exposes start(), handleMessage(data), clearTimer().
 */

export type WatchdogErrorType =
  | 'WATCHDOG_HEARTBEAT_TIMEOUT'
  | 'WEBGL_CONTEXT_LOST'
  | 'GAMEHUB_PREVIEW_CRASH'
  | string;

export interface WatchdogCrashEvent {
  errorType: WatchdogErrorType;
  message?: string;
  stack?: string;
  data?: unknown;
}

export interface RuntimeWatchdogOptions {
  timeoutMs?: number;
  onCrash: (crash: WatchdogCrashEvent) => void;
}

export class RuntimeWatchdogBridge {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly timeoutMs: number;
  private readonly onCrash: (crash: WatchdogCrashEvent) => void;
  private running = false;

  constructor(
    optionsOrCrashHandler: RuntimeWatchdogOptions | ((crash: WatchdogCrashEvent) => void),
    maybeTimeoutMs = 5000,
  ) {
    if (typeof optionsOrCrashHandler === 'function') {
      this.onCrash = optionsOrCrashHandler;
      this.timeoutMs = maybeTimeoutMs;
    } else {
      this.onCrash = optionsOrCrashHandler.onCrash;
      this.timeoutMs = optionsOrCrashHandler.timeoutMs ?? 5000;
    }
  }

  /**
   * Starts or restarts the heartbeat watchdog timer.
   */
  start(): void {
    this.running = true;
    this.resetTimer();
  }

  /**
   * Clears the active watchdog timeout.
   */
  clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Stops the watchdog entirely.
   */
  stop(): void {
    this.running = false;
    this.clearTimer();
  }

  /**
   * Returns true if the watchdog is actively running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Resets the heartbeat timeout timer.
   */
  private resetTimer(): void {
    this.clearTimer();
    if (!this.running) return;

    this.timer = setTimeout(() => {
      this.clearTimer();
      this.running = false;
      this.onCrash({
        errorType: 'WATCHDOG_HEARTBEAT_TIMEOUT',
        message: `Watchdog heartbeat timed out after ${this.timeoutMs}ms without preview activity.`,
      });
    }, this.timeoutMs);
  }

  /**
   * Ingests postMessage events from the preview window or host message listener.
   * Handles raw payload objects or MessageEvent instances.
   */
  handleMessage(data: unknown): void {
    if (!data || typeof data !== 'object') {
      return;
    }

    // Unpack MessageEvent data if passed directly
    const payload =
      'data' in data &&
      (data as { data: unknown }).data &&
      typeof (data as { data: unknown }).data === 'object'
        ? ((data as { data: unknown }).data as Record<string, unknown>)
        : (data as Record<string, unknown>);

    const type = typeof payload.type === 'string' ? payload.type : '';

    if (type === 'GAMEHUB_PREVIEW_HEARTBEAT') {
      // Keepalive reset
      this.resetTimer();
      return;
    }

    if (type === 'webglcontextlost') {
      this.clearTimer();
      this.running = false;
      this.onCrash({
        errorType: 'WEBGL_CONTEXT_LOST',
        message: typeof payload.message === 'string' ? payload.message : 'WebGL context was lost.',
        stack: typeof payload.stack === 'string' ? payload.stack : undefined,
        data: payload,
      });
      return;
    }

    if (type === 'GAMEHUB_PREVIEW_CRASH') {
      this.clearTimer();
      this.running = false;
      const errorType =
        typeof payload.errorType === 'string' && payload.errorType.length > 0
          ? payload.errorType
          : 'WEBGL_CONTEXT_LOST';

      this.onCrash({
        errorType,
        message: typeof payload.message === 'string' ? payload.message : 'Preview runtime crashed.',
        stack: typeof payload.stack === 'string' ? payload.stack : undefined,
        data: payload,
      });
      return;
    }
  }
}
