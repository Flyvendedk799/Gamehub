import React from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewPane } from '../src/components/PreviewPane';
import {
  RuntimeWatchdogBridge,
  type WatchdogCrashEvent,
} from '../src/components/RuntimeWatchdogBridge';
import { deriveGenerationData } from '../src/lib/generation-inspector-data';
import {
  PREVIEW_IFRAME_ORIGIN,
  RUNTIME_ALIVE_MESSAGE_TYPE,
  RUNTIME_ERROR_MESSAGE_TYPE,
  isPreviewIframeOrigin,
  parseInboundBridgeMessage,
  parseRuntimeAliveMessage,
  parseRuntimeErrorMessage,
} from '../src/lib/iframe-bridge';
import type { SseEvent } from '../src/lib/types';

describe('PreviewPane & Event Adapter Integration', () => {
  describe('deriveGenerationData event adapter', () => {
    it('maps representative native tool events, phases, and reflexion turns correctly', () => {
      const t0 = '2026-10-19T10:00:00.000Z';
      const t1 = '2026-10-19T10:00:00.250Z';
      const t2 = '2026-10-19T10:00:01.000Z';
      const t3 = '2026-10-19T10:00:01.400Z';
      const t4 = '2026-10-19T10:00:02.000Z';

      const events: SseEvent[] = [
        {
          type: 'turn_start',
          runId: 'r1',
          turnIndex: 0,
          timestamp: t0,
        },
        {
          type: 'thinking_delta',
          runId: 'r1',
          delta: 'Designing core arcade physics loop...',
          timestamp: t0,
        },
        {
          type: 'tool_use',
          runId: 'r1',
          toolName: 'str_replace_based_edit_tool',
          status: 'start',
          path: 'src/main.js',
          label: 'writing src/main.js',
          input: { command: 'create', path: 'src/main.js' },
          timestamp: t0,
        },
        {
          type: 'tool_result',
          runId: 'r1',
          toolName: 'str_replace_based_edit_tool',
          success: true,
          label: 'wrote src/main.js',
          timestamp: t1,
        },
        {
          type: 'tool_use',
          runId: 'r1',
          toolName: 'verify_artifact',
          status: 'start',
          label: 'verifying the build',
          timestamp: t2,
        },
        {
          type: 'tool_result',
          runId: 'r1',
          toolName: 'verify_artifact',
          success: false,
          label: 'build needs fixes',
          timestamp: t3,
        },
        {
          type: 'tool_use',
          runId: 'r1',
          toolName: 'patch_file_reflexion',
          status: 'start',
          label: 'repairing AST syntax',
          timestamp: t4,
        },
      ];

      const derived = deriveGenerationData(events, true, false);

      // Phase progression reached repairing with reflexion turn 2
      expect(derived.phase).toBe('repairing');
      expect(derived.reflexionTurn).toBe(2);
      expect(derived.maxReflexionTurns).toBe(2);

      // Invocations mapped with durations
      expect(derived.invocations).toHaveLength(3);
      const editInv = derived.invocations[0];
      expect(editInv?.toolName).toBe('str_replace_based_edit_tool');
      expect(editInv?.status).toBe('completed');
      expect(editInv?.durationMs).toBe(250);

      const verifyInv = derived.invocations[1];
      expect(verifyInv?.toolName).toBe('verify_artifact');
      expect(verifyInv?.status).toBe('failed');
      expect(verifyInv?.durationMs).toBe(400);

      const patchInv = derived.invocations[2];
      expect(patchInv?.toolName).toBe('patch_file_reflexion');
      expect(patchInv?.status).toBe('streaming');

      // Thinking blocks correctly folded by turnIndex
      expect(derived.thinkingBlocks).toHaveLength(1);
      expect(derived.thinkingBlocks[0]?.turnIndex).toBe(0);
      expect(derived.thinkingBlocks[0]?.thinking).toBe('Designing core arcade physics loop...');

      // Honest unavailable state when no token_usage events are present (no fake numbers)
      expect(derived.telemetry.usedTokens).toBeUndefined();
      expect(derived.telemetry.modelLimit).toBeUndefined();
    });

    it('derives real telemetry from token_usage events with accumulation and unknown state handling', () => {
      // 1) When no usage events exist: honest unavailable state
      const emptyDerived = deriveGenerationData([], true, false);
      expect(emptyDerived.telemetry.usedTokens).toBeUndefined();
      expect(emptyDerived.telemetry.inputTokens).toBeUndefined();
      expect(emptyDerived.telemetry.outputTokens).toBeUndefined();
      expect(emptyDerived.telemetry.cachedTokens).toBeUndefined();
      expect(emptyDerived.telemetry.modelLimit).toBeUndefined();

      // 2) Real typed token_usage event payload values
      const usageEvents: SseEvent[] = [
        {
          type: 'token_usage',
          runId: 'r1',
          inputTokens: 12500,
          outputTokens: 3200,
          totalTokens: 15700,
          cacheReadTokens: 4000,
          cacheWriteTokens: 1000,
          modelLimit: 128000,
          timestamp: '2026-10-19T10:01:00.000Z',
        },
      ];

      const withUsage = deriveGenerationData(usageEvents, true, false);
      expect(withUsage.telemetry.usedTokens).toBe(15700);
      expect(withUsage.telemetry.inputTokens).toBe(12500);
      expect(withUsage.telemetry.outputTokens).toBe(3200);
      expect(withUsage.telemetry.cachedTokens).toBe(4000);
      expect(withUsage.telemetry.modelLimit).toBe(128000);

      // 3) Subsequent turn updates update to cumulative totals
      const multiTurnUsageEvents: SseEvent[] = [
        ...usageEvents,
        {
          type: 'token_usage',
          runId: 'r1',
          inputTokens: 25000,
          outputTokens: 6800,
          totalTokens: 31800,
          cacheReadTokens: 8500,
          cacheWriteTokens: 2000,
          modelLimit: 128000,
          timestamp: '2026-10-19T10:02:00.000Z',
        },
      ];

      const multiTurn = deriveGenerationData(multiTurnUsageEvents, false, false);
      expect(multiTurn.telemetry.usedTokens).toBe(31800);
      expect(multiTurn.telemetry.inputTokens).toBe(25000);
      expect(multiTurn.telemetry.outputTokens).toBe(6800);
      expect(multiTurn.telemetry.cachedTokens).toBe(8500);
      expect(multiTurn.telemetry.modelLimit).toBe(128000);
    });

    it('maps run_error into diagnostic items and failed phase', () => {
      const events: SseEvent[] = [
        {
          type: 'run_error',
          runId: 'r2',
          error: 'Babel parse error: Unexpected token on line 24',
          timestamp: '2026-10-19T10:05:00.000Z',
        },
      ];

      const derived = deriveGenerationData(events, false, true);

      expect(derived.phase).toBe('failed');
      expect(derived.diagnostics).toHaveLength(1);
      expect(derived.diagnostics[0]?.message).toContain('Babel parse error');
      expect(derived.diagnostics[0]?.severity).toBe('error');
    });
  });

  describe('PreviewPane rendering and sandbox isolation', () => {
    it('renders iframe with strict sandbox flags and progress stepper when building', () => {
      const html = renderToString(
        <PreviewPane
          previewUrl="https://playforge.internal/preview/test-game"
          isBuilding={true}
          hasError={false}
          events={[
            {
              type: 'tool_use',
              runId: 'r1',
              toolName: 'str_replace_based_edit_tool',
              status: 'start',
              path: 'src/main.js',
              timestamp: '2026-10-19T10:00:00.000Z',
            },
          ]}
        />,
      );

      // Strict sandbox isolation: allow-scripts allow-forms allow-same-origin allow-pointer-lock allow-downloads
      expect(html).toContain(
        'sandbox="allow-scripts allow-forms allow-same-origin allow-pointer-lock allow-downloads"',
      );

      // Contains generation progress stepper landmarks
      expect(html).toContain('aria-label="Game Generation Progress"');
      expect(html).toContain('Writing Code');

      // Contains toolbar tab buttons including inspector
      expect(html).toContain('preview');
      expect(html).toContain('controls');
      expect(html).toContain('files');
      expect(html).toContain('scene');
      expect(html).toContain('inspector');
    });
  });

  describe('Message Origin Validation & Heartbeat Bridge', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('validates trusted origin and rejects foreign origin frames', () => {
      expect(isPreviewIframeOrigin(PREVIEW_IFRAME_ORIGIN)).toBe(true);
      expect(isPreviewIframeOrigin('https://malicious-origin.com')).toBe(false);
      expect(isPreviewIframeOrigin('http://localhost:3000')).toBe(false);

      const foreignEvent = {
        origin: 'https://attacker.site',
        data: { type: RUNTIME_ALIVE_MESSAGE_TYPE, raf: 60 },
      } as MessageEvent<unknown>;

      expect(parseRuntimeAliveMessage(foreignEvent)).toBeNull();
      expect(parseRuntimeErrorMessage(foreignEvent)).toBeNull();
      expect(parseInboundBridgeMessage(foreignEvent)).toBeNull();
    });

    it('maps valid runtime:alive heartbeat and resets watchdog timer to prevent false timeouts', () => {
      const onCrash = vi.fn<(crash: WatchdogCrashEvent) => void>();
      const watchdog = new RuntimeWatchdogBridge({ onCrash, timeoutMs: 5000 });
      watchdog.start();

      // Parse a valid runtime alive message from the preview origin
      const validAliveEvent = {
        origin: PREVIEW_IFRAME_ORIGIN,
        data: { type: RUNTIME_ALIVE_MESSAGE_TYPE, raf: 60 },
      } as MessageEvent<unknown>;

      const parsedAlive = parseRuntimeAliveMessage(validAliveEvent);
      expect(parsedAlive).not.toBeNull();
      expect(parsedAlive?.raf).toBe(60);

      // Advance 3000ms
      vi.advanceTimersByTime(3000);
      expect(onCrash).not.toHaveBeenCalled();

      // Feed parsed keepalive heartbeat
      if (parsedAlive && parsedAlive.raf > 0) {
        watchdog.handleMessage({ type: 'GAMEHUB_PREVIEW_HEARTBEAT' });
      }

      // Advance another 3000ms (6000ms total, but only 3000ms since beat)
      vi.advanceTimersByTime(3000);
      expect(onCrash).not.toHaveBeenCalled();

      // Advance another 3000ms (still active)
      watchdog.handleMessage({ type: 'GAMEHUB_PREVIEW_HEARTBEAT' });
      vi.advanceTimersByTime(3000);
      expect(onCrash).not.toHaveBeenCalled();

      // Allow full 5000ms to elapse without heartbeat -> triggers timeout
      vi.advanceTimersByTime(5000);
      expect(onCrash).toHaveBeenCalledTimes(1);
      expect(onCrash).toHaveBeenCalledWith(
        expect.objectContaining({
          errorType: 'WATCHDOG_HEARTBEAT_TIMEOUT',
        }),
      );
    });

    it('safely rejects unrelated messages without resetting timer or causing false positives', () => {
      const onCrash = vi.fn<(crash: WatchdogCrashEvent) => void>();
      const watchdog = new RuntimeWatchdogBridge({ onCrash, timeoutMs: 5000 });
      watchdog.start();

      // Advance 2500ms
      vi.advanceTimersByTime(2500);

      // Ingest unrelated messages
      watchdog.handleMessage({ type: 'SOME_UNRELATED_EXTENSION_MESSAGE' });
      watchdog.handleMessage({ type: 'webpackOk' });
      watchdog.handleMessage(null);
      watchdog.handleMessage('string-message');

      // The unrelated messages must NOT reset the timer.
      // After 2500ms more (5000ms total), timeout must trigger.
      vi.advanceTimersByTime(2500);
      expect(onCrash).toHaveBeenCalledTimes(1);
      expect(onCrash).toHaveBeenCalledWith(
        expect.objectContaining({
          errorType: 'WATCHDOG_HEARTBEAT_TIMEOUT',
        }),
      );
    });

    it('maps valid runtime:error from preview origin', () => {
      const validErrorEvent = {
        origin: PREVIEW_IFRAME_ORIGIN,
        data: {
          type: RUNTIME_ERROR_MESSAGE_TYPE,
          message: 'Uncaught TypeError: Cannot read properties of undefined (reading "x")',
          stack: 'TypeError: at Player.update (player.js:14:10)',
        },
      } as MessageEvent<unknown>;

      const parsedError = parseRuntimeErrorMessage(validErrorEvent);
      expect(parsedError).not.toBeNull();
      expect(parsedError?.message).toContain('Cannot read properties of undefined');
      expect(parsedError?.stack).toContain('player.js:14:10');
    });
  });
});
