'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';

export type ToolStatus = 'active' | 'streaming' | 'completed' | 'retrying' | 'failed';

export interface ToolInvocationItem {
  id: string;
  toolName: string;
  status: ToolStatus;
  durationMs?: number;
  label?: string;
  path?: string;
  diff?: string;
  code?: string;
  oldCode?: string;
  input?: Record<string, unknown>;
  output?: unknown;
  error?: string;
  timestamp?: number | string;
}

export interface ToolInvocationFeedProps {
  invocations: ToolInvocationItem[];
  title?: string;
  className?: string;
}

/**
 * Renders unified diff lines with additions, deletions, chunk headers, and line numbers.
 */
function DiffViewer({ diff, filename }: { diff: string; filename?: string }) {
  const lines = useMemo(() => diff.split(/\r?\n/), [diff]);

  return (
    <div className="mt-2 text-xs font-mono rounded border border-hairline bg-void/80 overflow-hidden">
      {filename && (
        <div className="px-3 py-1 bg-surface border-b border-hairline text-ink-3 flex items-center justify-between">
          <span className="font-semibold text-ink-2 truncate">{filename}</span>
          <span className="text-[10px] text-ink-4">diff</span>
        </div>
      )}
      <div className="p-2 overflow-x-auto max-h-64 space-y-0.5">
        {lines.map((line, idx) => {
          let lineClass = 'text-ink-3';
          let prefix = ' ';
          if (line.startsWith('+++') || line.startsWith('---')) {
            lineClass = 'text-ink-4 font-bold';
          } else if (line.startsWith('+')) {
            lineClass = 'text-emerald-400 bg-emerald-950/25 px-1 rounded-sm';
            prefix = '+';
          } else if (line.startsWith('-')) {
            lineClass = 'text-rose-400 bg-rose-950/25 px-1 rounded-sm';
            prefix = '-';
          } else if (line.startsWith('@@')) {
            lineClass = 'text-signal bg-signal/10 px-1 font-semibold';
          }

          return (
            <div
              key={`${idx}-${line.slice(0, 16)}`}
              className={`whitespace-pre leading-relaxed ${lineClass}`}
            >
              {line}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Status badge with violet glow, emerald check, amber wrench, or rose alert.
 */
function ToolStatusBadge({ status }: { status: ToolStatus }) {
  switch (status) {
    case 'active':
    case 'streaming':
      return (
        <span
          data-testid="status-badge-streaming"
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-mono font-medium border border-violet-500/50 text-violet-300 bg-violet-950/40 shadow-[0_0_12px_rgba(139,92,246,0.3)] animate-pulse"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-ping" />
          streaming
        </span>
      );
    case 'completed':
      return (
        <span
          data-testid="status-badge-completed"
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-mono font-medium border border-emerald-500/50 text-emerald-400 bg-emerald-950/40"
        >
          <span>✓</span>
          done
        </span>
      );
    case 'retrying':
      return (
        <span
          data-testid="status-badge-retrying"
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-mono font-medium border border-amber-500/50 text-amber-400 bg-amber-950/40"
        >
          <span>🔧</span>
          retrying
        </span>
      );
    case 'failed':
      return (
        <span
          data-testid="status-badge-failed"
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-mono font-medium border border-rose-500/50 text-rose-400 bg-rose-950/40"
        >
          <span>✕</span>
          failed
        </span>
      );
    default:
      return null;
  }
}

/**
 * Individual tool invocation card.
 */
export function ToolInvocationCard({ item }: { item: ToolInvocationItem }) {
  const [isDiffOpen, setIsDiffOpen] = useState(false);
  const hasDiffContent = Boolean(item.diff || item.code);

  const displayDiff = useMemo(() => {
    if (item.diff) return item.diff;
    if (item.code) {
      // Synthesize diff-like presentation if only code provided
      return item.code
        .split(/\r?\n/)
        .map((l) => `+ ${l}`)
        .join('\n');
    }
    return '';
  }, [item.diff, item.code]);

  return (
    <article
      data-testid={`tool-invocation-${item.id}`}
      className="p-3 bg-surface/70 border border-hairline rounded transition-colors hover:border-edge"
    >
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <ToolStatusBadge status={item.status} />
          <span className="font-mono text-xs font-semibold text-ink truncate">{item.toolName}</span>
          {item.path && (
            <span
              className="font-mono text-[11px] text-ink-3 truncate max-w-[200px]"
              title={item.path}
            >
              {item.path}
            </span>
          )}
        </div>

        <div className="flex items-center gap-3">
          {item.durationMs !== undefined && (
            <span className="font-mono tabular-nums text-xs text-ink-3">
              {`${item.durationMs}ms`}
            </span>
          )}
        </div>
      </div>

      {item.label && <p className="mt-1.5 text-xs text-ink-2 leading-relaxed">{item.label}</p>}

      {item.error && (
        <div className="mt-2 p-2 bg-rose-950/30 border border-rose-500/40 rounded text-xs font-mono text-rose-300">
          {item.error}
        </div>
      )}

      {hasDiffContent && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setIsDiffOpen((prev) => !prev)}
            aria-expanded={isDiffOpen}
            className="inline-flex items-center gap-1.5 font-mono text-[11px] text-signal hover:text-signal-bright transition-colors"
          >
            <span>{isDiffOpen ? '▾ Hide diff' : '▸ View code modifications'}</span>
          </button>
          {isDiffOpen && <DiffViewer diff={displayDiff} filename={item.path} />}
        </div>
      )}
    </article>
  );
}

export function ToolInvocationFeed({
  invocations,
  title = 'Agent Tool Invocations',
  className = '',
}: ToolInvocationFeedProps) {
  const [autoScroll, setAutoScroll] = useState(true);
  const feedContainerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll handler
  // biome-ignore lint/correctness/useExhaustiveDependencies: invocations triggers scroll-to-bottom on each new entry
  useEffect(() => {
    if (!autoScroll) return;
    const el = feedContainerRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [invocations, autoScroll]);

  return (
    <div
      className={`flex flex-col bg-chrome/90 border border-hairline rounded overflow-hidden ${className}`}
    >
      {/* Header with Title and Auto-scroll lock toggle */}
      <div className="px-4 py-2.5 bg-ground/80 border-b border-hairline flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="type-label text-ink">{title}</span>
          <span className="px-1.5 py-0.5 rounded font-mono text-[10px] bg-raised text-ink-3">
            {invocations.length}
          </span>
        </div>

        <button
          type="button"
          onClick={() => setAutoScroll((prev) => !prev)}
          aria-pressed={!autoScroll}
          data-testid="autoscroll-toggle"
          className={`px-2.5 py-1 text-xs font-mono rounded border transition-colors flex items-center gap-1.5 ${
            autoScroll
              ? 'border-signal/50 text-signal bg-signal/10 hover:bg-signal/20'
              : 'border-amber-500/50 text-amber-400 bg-amber-950/30 hover:bg-amber-950/50'
          }`}
          title={
            autoScroll
              ? 'Auto-scroll enabled (click to lock scroll)'
              : 'Scroll locked (click to auto-scroll)'
          }
        >
          <span className="text-[10px]">{autoScroll ? '↓' : '🔒'}</span>
          <span>{autoScroll ? 'Auto-scroll ON' : 'Scroll Locked'}</span>
        </button>
      </div>

      {/* Scrollable feed items container */}
      <div
        ref={feedContainerRef}
        data-testid="feed-container"
        className="p-3 space-y-2 overflow-y-auto max-h-[460px] min-h-[140px]"
      >
        {invocations.length === 0 ? (
          <div className="py-8 text-center text-ink-4 text-xs font-mono">
            No agent tool invocations recorded yet.
          </div>
        ) : (
          invocations.map((item) => <ToolInvocationCard key={item.id} item={item} />)
        )}
      </div>
    </div>
  );
}
