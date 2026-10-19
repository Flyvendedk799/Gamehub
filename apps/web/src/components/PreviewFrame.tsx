'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { isPreviewIframeOrigin } from '../lib/iframe-bridge';
import { RuntimeWatchdogBridge, type WatchdogCrashEvent } from './RuntimeWatchdogBridge';

export interface PreviewFrameProps {
  previewUrl?: string | null;
  srcDoc?: string;
  isBundling?: boolean;
  timeoutMs?: number;
  onCrash?: (crash: WatchdogCrashEvent) => void;
  onSelfHeal?: (crash: WatchdogCrashEvent) => void;
  className?: string;
  title?: string;
}

/**
 * PreviewFrame
 *
 * Renders an isolated game preview inside an opaque-origin iframe container.
 *
 * CRITICAL SECURITY INVARIANT:
 * Per PRD Section 3.4.2 and QA Audit doc-fc216e9380bf19b62ca9f55879fd60b6e52123ce,
 * the sandbox attribute MUST strictly be "allow-scripts allow-forms".
 * NEVER use `allow-same-origin` and NEVER use `allow-modals`.
 */
export function PreviewFrame({
  previewUrl,
  srcDoc,
  isBundling = false,
  timeoutMs = 5000,
  onCrash,
  onSelfHeal,
  className = '',
  title = 'Game Preview',
}: PreviewFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [crash, setCrash] = useState<WatchdogCrashEvent | null>(null);
  const [isDismissed, setIsDismissed] = useState(false);
  const watchdogRef = useRef<RuntimeWatchdogBridge | null>(null);

  const handleCrash = useCallback(
    (crashEvent: WatchdogCrashEvent) => {
      setCrash(crashEvent);
      setIsDismissed(false);
      onCrash?.(crashEvent);
    },
    [onCrash],
  );

  // Initialize watchdog bridge
  useEffect(() => {
    const bridge = new RuntimeWatchdogBridge({
      timeoutMs,
      onCrash: handleCrash,
    });
    watchdogRef.current = bridge;

    const handleWindowMessage = (event: MessageEvent) => {
      // Validate source window matches our iframe
      if (iframeRef.current && event.source !== iframeRef.current.contentWindow) {
        return;
      }
      // Validate origin (trusted preview origin, same-origin, or sandboxed null origin)
      if (
        event.origin !== 'null' &&
        typeof window !== 'undefined' &&
        event.origin !== window.location.origin &&
        !isPreviewIframeOrigin(event.origin)
      ) {
        return;
      }
      bridge.handleMessage(event.data);
    };

    window.addEventListener('message', handleWindowMessage);

    // If we have content to load and not bundling, start watchdog
    if ((previewUrl || srcDoc) && !isBundling) {
      bridge.start();
    }

    return () => {
      window.removeEventListener('message', handleWindowMessage);
      bridge.clearTimer();
      watchdogRef.current = null;
    };
  }, [previewUrl, srcDoc, isBundling, timeoutMs, handleCrash]);

  // Reset crash state when previewUrl or srcDoc changes
  useEffect(() => {
    setCrash(null);
    setIsDismissed(false);
    if ((previewUrl || srcDoc) && !isBundling) {
      watchdogRef.current?.start();
    } else {
      watchdogRef.current?.clearTimer();
    }
  }, [previewUrl, srcDoc, isBundling]);

  const handleReload = () => {
    setCrash(null);
    setIsDismissed(false);
    watchdogRef.current?.start();
    if (iframeRef.current) {
      if (previewUrl) {
        iframeRef.current.src = previewUrl;
      } else if (srcDoc) {
        const currentDoc = srcDoc;
        iframeRef.current.srcdoc = '';
        setTimeout(() => {
          if (iframeRef.current) {
            iframeRef.current.srcdoc = currentDoc;
          }
        }, 0);
      }
    }
  };

  const handleSelfHealClick = () => {
    if (crash) {
      onSelfHeal?.(crash);
    }
  };

  return (
    <div
      data-testid="preview-frame-container"
      className={`relative w-full h-full min-h-[300px] bg-void rounded border border-hairline overflow-hidden ${className}`}
    >
      {/* 1. Bundling Shimmer Skeleton */}
      {isBundling && (
        <div
          data-testid="bundling-shimmer"
          className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-ground/90 backdrop-blur-sm p-6"
        >
          <div className="w-full max-w-md space-y-4">
            {/* Shimmer header */}
            <div className="flex items-center space-x-3">
              <div className="w-8 h-8 rounded-full bg-raised animate-pulse" />
              <div className="space-y-1.5 flex-1">
                <div className="h-4 bg-raised rounded w-3/4 animate-pulse" />
                <div className="h-3 bg-surface rounded w-1/2 animate-pulse" />
              </div>
            </div>

            {/* Shimmer canvas skeleton */}
            <div className="w-full h-56 bg-surface/60 rounded border border-edge/40 relative overflow-hidden">
              <div className="absolute inset-0 -translate-x-full animate-[shimmer_2s_infinite] bg-gradient-to-r from-transparent via-white/5 to-transparent" />
              <div className="flex items-center justify-center h-full">
                <span className="font-mono text-xs text-signal tracking-widest uppercase animate-pulse">
                  Bundling Game Code...
                </span>
              </div>
            </div>

            {/* Shimmer progress bars */}
            <div className="space-y-2">
              <div className="h-2 bg-raised rounded w-full animate-pulse" />
              <div className="h-2 bg-surface rounded w-5/6 animate-pulse" />
            </div>
          </div>
        </div>
      )}

      {/* 2. Isolated Sandboxed Iframe */}
      {(previewUrl || srcDoc) && !isBundling && (
        <iframe
          ref={iframeRef}
          src={previewUrl || undefined}
          srcDoc={srcDoc || undefined}
          title={title}
          /*
           * STRICT SECURITY RULE:
           * sandbox="allow-scripts allow-forms"
           * NO allow-same-origin and NO allow-modals
           */
          sandbox="allow-scripts allow-forms"
          className="w-full h-full border-0 bg-void"
          data-testid="sandboxed-preview-iframe"
        />
      )}

      {/* Empty State */}
      {!previewUrl && !srcDoc && !isBundling && (
        <div className="flex items-center justify-center w-full h-full text-ink-4 font-mono text-xs">
          No preview content available.
        </div>
      )}

      {/* 3. Crash Overlay with Stack Trace and Self-Healing Action */}
      {crash && !isDismissed && (
        <div
          data-testid="crash-overlay"
          className="absolute inset-0 z-40 flex flex-col justify-end bg-void/80 backdrop-blur-sm p-4 sm:p-6"
        >
          <div className="bg-chrome border border-rose-500/60 rounded-lg p-4 shadow-2xl max-w-2xl mx-auto w-full space-y-3">
            {/* Header */}
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className="text-rose-400 text-lg">⚠️</span>
                <div>
                  <h3 className="text-sm font-semibold text-rose-300 font-mono">
                    Runtime Crash Detected
                  </h3>
                  <span
                    data-testid="crash-error-type"
                    className="inline-block mt-0.5 px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase bg-rose-950 text-rose-400 border border-rose-500/50"
                  >
                    {crash.errorType}
                  </span>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setIsDismissed(true)}
                className="text-ink-4 hover:text-ink text-sm px-2 py-1 rounded"
                title="Dismiss overlay"
              >
                ✕
              </button>
            </div>

            {/* Error Message */}
            {crash.message && (
              <p className="text-xs text-ink-2 font-mono bg-void/80 p-2.5 rounded border border-hairline break-words">
                {crash.message}
              </p>
            )}

            {/* Stack Trace */}
            {crash.stack && (
              <div className="space-y-1">
                <span className="text-[10px] uppercase font-mono tracking-wider text-ink-4 font-semibold">
                  Stack Trace
                </span>
                <pre
                  data-testid="crash-stack-trace"
                  className="text-[11px] font-mono text-rose-300/90 bg-void p-2.5 rounded border border-edge overflow-x-auto max-h-36 leading-relaxed whitespace-pre"
                >
                  {crash.stack}
                </pre>
              </div>
            )}

            {/* Actions */}
            <div className="pt-2 border-t border-hairline flex items-center justify-between gap-2 flex-wrap">
              <button
                type="button"
                onClick={handleReload}
                className="px-3 py-1.5 rounded text-xs font-mono border border-hairline text-ink-2 hover:text-ink hover:bg-surface transition-colors"
              >
                ↻ Reload Preview
              </button>

              <div className="flex items-center gap-2">
                {onSelfHeal && (
                  <button
                    type="button"
                    onClick={handleSelfHealClick}
                    data-testid="self-heal-button"
                    className="px-4 py-1.5 rounded text-xs font-semibold font-mono bg-signal text-void hover:bg-signal-bright transition-colors shadow-[0_0_12px_rgba(70,230,240,0.3)] flex items-center gap-1.5"
                  >
                    <span>⚡</span>
                    Self-Heal Runtime Issue
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
