'use client';

import React, { useState } from 'react';

// ─── Thinking Block Types (mirrors packages/core/src/engine/context.ts) ──────

export interface ThinkingBlockPayload {
  turnIndex: number;
  signature?: string;
  thinking: string;
}

// ─── AST Diagnostic Types ───────────────────────────────────────────────────

export interface DiagnosticItem {
  id?: string;
  filename: string;
  message: string;
  line: number;
  column: number;
  severity: 'error' | 'warning';
  suggestedRemediation?: string;
}

// ─── Token Telemetry Types ──────────────────────────────────────────────────

export interface TokenTelemetryData {
  usedTokens?: number;
  modelLimit?: number; // Defaults to 200_000 (e.g. Claude 3.7 / GPT-4o window)
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
}

// ─── 1. TokenTelemetryGauge ─────────────────────────────────────────────────

export interface TokenTelemetryGaugeProps {
  telemetry: TokenTelemetryData;
  className?: string;
}

export function TokenTelemetryGauge({ telemetry, className = '' }: TokenTelemetryGaugeProps) {
  const hasMeasurement = typeof telemetry.usedTokens === 'number';
  const hasLimit = typeof telemetry.modelLimit === 'number' && telemetry.modelLimit > 0;
  const usedTokens = hasMeasurement ? Math.max(0, telemetry.usedTokens!) : undefined;
  const modelLimit = hasLimit ? telemetry.modelLimit : hasMeasurement ? 200_000 : undefined;
  const percentage =
    hasMeasurement && modelLimit
      ? Math.min(100, Math.round((usedTokens! / modelLimit) * 100))
      : null;
  const isCompactionWarning = percentage !== null && percentage >= 80;

  return (
    <div
      data-testid="token-telemetry-gauge"
      className={`p-3 bg-surface/80 border border-hairline rounded font-mono ${className}`}
    >
      <div className="flex items-center justify-between text-xs mb-1.5">
        <span className="type-label text-ink flex items-center gap-1.5">
          <span>⚡ Context Window</span>
          {isCompactionWarning && (
            <span
              data-testid="compaction-badge"
              className="px-1.5 py-0.5 rounded text-[10px] bg-amber-950/60 border border-amber-500/50 text-amber-300 animate-pulse font-normal"
            >
              Pruning Imminent (≥80%)
            </span>
          )}
        </span>
        <span className="text-ink-3 tabular-nums text-[11px]">
          {hasMeasurement ? (
            <>
              <strong className="text-ink font-semibold">{usedTokens!.toLocaleString()}</strong> /{' '}
              {modelLimit ? `${modelLimit.toLocaleString()} tokens` : '—'}{' '}
              {percentage !== null ? `(${percentage}%)` : ''}
            </>
          ) : (
            <span className="text-ink-4 italic" data-testid="telemetry-unavailable">
              Unavailable
            </span>
          )}
        </span>
      </div>

      {/* Progress Track with 80% Compaction Threshold Marker */}
      <div className="relative h-3 w-full bg-void rounded-sm overflow-hidden border border-edge/60">
        {/* Fill bar */}
        <div
          data-testid="token-gauge-bar"
          className={`h-full transition-all duration-500 ease-out ${
            percentage !== null && percentage >= 95
              ? 'bg-rose-500'
              : percentage !== null && percentage >= 80
                ? 'bg-amber-400'
                : 'bg-signal'
          }`}
          style={{ width: `${percentage ?? 0}%` }}
        />

        {/* 80% Compaction Threshold Marker */}
        <div
          data-testid="compaction-threshold-marker"
          className="absolute top-0 bottom-0 w-0.5 bg-amber-500 z-10 shadow-[0_0_6px_rgba(245,158,11,0.8)]"
          style={{ left: '80%' }}
          title="80% Compaction Threshold: Atomic context pruning activates here"
        />
      </div>

      {/* Markers legend */}
      <div className="relative mt-1 flex justify-between text-[10px] text-ink-4">
        <span>0</span>
        <span
          data-testid="compaction-threshold-label"
          className="text-amber-400 font-semibold absolute -translate-x-1/2"
          style={{ left: '80%' }}
        >
          80% Compaction
        </span>
        <span>
          {modelLimit
            ? modelLimit >= 1000
              ? `${Math.round(modelLimit / 1000)}k`
              : modelLimit
            : '—'}
        </span>
      </div>

      {/* Token breakdown if available */}
      {(telemetry.inputTokens !== undefined || telemetry.outputTokens !== undefined) && (
        <div className="mt-2 pt-2 border-t border-hairline/60 grid grid-cols-3 gap-2 text-[10px] text-ink-3">
          <div>
            <span className="text-ink-4 block">Input</span>
            <span className="tabular-nums font-medium text-ink-2">
              {telemetry.inputTokens?.toLocaleString() ?? '—'}
            </span>
          </div>
          <div>
            <span className="text-ink-4 block">Output</span>
            <span className="tabular-nums font-medium text-ink-2">
              {telemetry.outputTokens?.toLocaleString() ?? '—'}
            </span>
          </div>
          <div>
            <span className="text-ink-4 block">Cached</span>
            <span className="tabular-nums font-medium text-ink-2">
              {telemetry.cachedTokens?.toLocaleString() ?? '—'}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── 2. ThinkingBlockViewer ─────────────────────────────────────────────────

export interface ThinkingBlockViewerProps {
  thinkingBlocks: ThinkingBlockPayload[];
  className?: string;
  initialExpanded?: boolean;
}

export function ThinkingBlockViewer({
  thinkingBlocks,
  className = '',
  initialExpanded = false,
}: ThinkingBlockViewerProps) {
  const [isOpen, setIsOpen] = useState(initialExpanded);
  const [expandedTurns, setExpandedTurns] = useState<Record<number, boolean>>({});

  const toggleTurn = (turnIndex: number) => {
    setExpandedTurns((prev) => ({
      ...prev,
      [turnIndex]: !prev[turnIndex],
    }));
  };

  if (thinkingBlocks.length === 0) {
    return null;
  }

  return (
    <div
      data-testid="thinking-block-viewer"
      className={`border border-hairline rounded bg-chrome/80 overflow-hidden ${className}`}
    >
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        aria-expanded={isOpen}
        data-testid="toggle-thinking-drawer"
        className="w-full px-3.5 py-2.5 bg-ground/90 flex items-center justify-between text-xs text-left hover:bg-surface/80 transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="text-purple-400 font-mono">🧠</span>
          <span className="type-label text-ink">Extended Reasoning / Thinking Blocks</span>
          <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-purple-950/50 text-purple-300 border border-purple-500/30">
            {thinkingBlocks.length} {thinkingBlocks.length === 1 ? 'block' : 'blocks'}
          </span>
        </div>
        <span className="font-mono text-ink-3 text-xs">{isOpen ? '▾ Collapse' : '▸ Expand'}</span>
      </button>

      {isOpen && (
        <div
          data-testid="thinking-blocks-content"
          className="p-3 space-y-3 max-h-96 overflow-y-auto"
        >
          {thinkingBlocks.map((block) => {
            const isTurnExpanded = expandedTurns[block.turnIndex] ?? true;

            return (
              <div
                key={`${block.turnIndex}-${block.signature || 'nosig'}`}
                data-testid={`thinking-turn-${block.turnIndex}`}
                className="rounded border border-purple-900/40 bg-purple-950/10 overflow-hidden"
              >
                <button
                  type="button"
                  onClick={() => toggleTurn(block.turnIndex)}
                  className="w-full px-3 py-1.5 bg-purple-950/30 border-b border-purple-900/30 flex items-center justify-between cursor-pointer text-xs text-left"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-semibold text-purple-300">
                      {`Turn ${block.turnIndex + 1}`}
                    </span>
                    {block.signature && (
                      <span
                        className="font-mono text-[10px] px-1 rounded bg-purple-900/40 text-purple-200 truncate max-w-[150px]"
                        title={`Signature: ${block.signature}`}
                      >
                        {`sig: ${block.signature.slice(0, 10)}...`}
                      </span>
                    )}
                  </div>
                  <span className="font-mono text-[10px] text-purple-400">
                    {isTurnExpanded ? 'hide' : 'show'}
                  </span>
                </button>

                {isTurnExpanded && (
                  <div className="p-3 font-mono text-xs text-ink-2 whitespace-pre-wrap leading-relaxed max-h-60 overflow-y-auto bg-void/40">
                    {block.thinking}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── 3. DiagnosticCalloutList ───────────────────────────────────────────────

export interface DiagnosticCalloutListProps {
  diagnostics: DiagnosticItem[];
  className?: string;
  onApplyRemediation?: (diagnostic: DiagnosticItem) => void;
}

export function DiagnosticCalloutList({
  diagnostics,
  className = '',
  onApplyRemediation,
}: DiagnosticCalloutListProps) {
  if (diagnostics.length === 0) {
    return null;
  }

  return (
    <div
      data-testid="diagnostic-callout-list"
      className={`border border-hairline rounded bg-chrome/80 overflow-hidden ${className}`}
    >
      <div className="px-3.5 py-2.5 bg-ground/90 border-b border-hairline flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-rose-400 font-mono text-sm">⚠</span>
          <span className="type-label text-ink">AST Compiler Diagnostics</span>
          <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-rose-950/50 text-rose-300 border border-rose-500/30">
            {diagnostics.length} {diagnostics.length === 1 ? 'issue' : 'issues'}
          </span>
        </div>
      </div>

      <div className="p-3 space-y-2.5 max-h-80 overflow-y-auto">
        {diagnostics.map((diag, idx) => {
          const isError = diag.severity === 'error';
          const containerStyle = isError
            ? 'border-rose-500/40 bg-rose-950/20'
            : 'border-amber-500/40 bg-amber-950/20';

          return (
            <div
              key={diag.id || `${diag.filename}-${diag.line}-${diag.column}-${idx}`}
              data-testid={`diagnostic-item-${idx}`}
              className={`p-3 rounded border ${containerStyle} font-mono text-xs`}
            >
              <div className="flex items-center justify-between gap-2 flex-wrap mb-1">
                <div className="flex items-center gap-2">
                  <span
                    className={`px-1.5 py-0.2 rounded text-[10px] uppercase font-bold ${
                      isError
                        ? 'bg-rose-900/60 text-rose-300 border border-rose-500/50'
                        : 'bg-amber-900/60 text-amber-300 border border-amber-500/50'
                    }`}
                  >
                    {diag.severity}
                  </span>
                  <span className="font-semibold text-ink-1 truncate max-w-[220px]">
                    {diag.filename}
                  </span>
                </div>

                {/* Line & Column pointer */}
                <span
                  data-testid="line-col-pointer"
                  className="text-signal bg-signal/10 px-1.5 py-0.5 rounded border border-signal/20 text-[11px] tabular-nums"
                >
                  {`L${diag.line}:C${diag.column}`}
                </span>
              </div>

              {/* Error Message */}
              <p className="text-ink-2 leading-relaxed mt-1 break-words">{diag.message}</p>

              {/* Suggested Remediation Directive */}
              {diag.suggestedRemediation && (
                <div className="mt-2 p-2 bg-void/60 border border-edge rounded flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <span className="text-[10px] text-amber-300 uppercase tracking-wider block font-semibold">
                      💡 Suggested Remediation
                    </span>
                    <span className="text-ink-3 text-[11px] leading-relaxed break-words">
                      {diag.suggestedRemediation}
                    </span>
                  </div>
                  {onApplyRemediation && (
                    <button
                      type="button"
                      onClick={() => onApplyRemediation(diag)}
                      className="flex-shrink-0 px-2 py-1 rounded text-[10px] font-medium bg-amber-500/20 text-amber-300 border border-amber-500/40 hover:bg-amber-500/30 transition-colors"
                    >
                      Remediate
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Main GenerationInspector Component ─────────────────────────────────────

export interface GenerationInspectorProps {
  telemetry?: TokenTelemetryData;
  thinkingBlocks?: ThinkingBlockPayload[];
  diagnostics?: DiagnosticItem[];
  onApplyRemediation?: (diagnostic: DiagnosticItem) => void;
  className?: string;
}

export function GenerationInspector({
  telemetry,
  thinkingBlocks = [],
  diagnostics = [],
  onApplyRemediation,
  className = '',
}: GenerationInspectorProps) {
  return (
    <section aria-label="Generation Inspector" className={`space-y-3 ${className}`}>
      {telemetry && <TokenTelemetryGauge telemetry={telemetry} />}
      {thinkingBlocks.length > 0 && <ThinkingBlockViewer thinkingBlocks={thinkingBlocks} />}
      {diagnostics.length > 0 && (
        <DiagnosticCalloutList diagnostics={diagnostics} onApplyRemediation={onApplyRemediation} />
      )}
    </section>
  );
}
