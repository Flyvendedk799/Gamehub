import React from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  DiagnosticCalloutList,
  GenerationInspector,
  ThinkingBlockViewer,
  TokenTelemetryGauge,
} from '../src/components/GenerationInspector';
import { GenerationProgressStepper } from '../src/components/GenerationProgressStepper';
import { PreviewFrame } from '../src/components/PreviewFrame';
import { ToolInvocationCard, ToolInvocationFeed } from '../src/components/ToolInvocationFeed';

describe('GenerationProgressStepper', () => {
  it('renders all 7 phases with accessible ARIA semantics', () => {
    const html = renderToString(<GenerationProgressStepper currentPhase="writing_code" />);

    // ARIA landmarks & list semantics
    expect(html).toContain('aria-label="Game Generation Progress"');
    expect(html).toContain('role="list"');
    expect(html).toContain('<li');
    expect(html).toContain('aria-current="step"');
    expect(html).toContain('aria-live="polite"');

    // All 7 phases rendered
    expect(html).toContain('Analyzing');
    expect(html).toContain('Planning');
    expect(html).toContain('Writing Code');
    expect(html).toContain('Verifying');
    expect(html).toContain('Repairing');
    expect(html).toContain('Bundling');
    expect(html).toContain('Completed');
  });

  it('renders High-visibility Amber Reflexion Pulse when in repairing state', () => {
    const html = renderToString(
      <GenerationProgressStepper
        currentPhase="repairing"
        reflexionTurn={1}
        maxReflexionTurns={2}
      />,
    );

    // Exact amber pulse classes required by spec
    expect(html).toContain('animate-pulse');
    expect(html).toContain('text-amber-400');
    expect(html).toContain('bg-amber-950/40');
    expect(html).toContain('border-amber-500/50');

    // Retry badge indicator [Reflexion Turn N/2]
    expect(html).toContain('[Reflexion Turn 1/2]');
  });

  it('renders completed, active, and failed phases properly', () => {
    const completedHtml = renderToString(<GenerationProgressStepper currentPhase="completed" />);
    expect(completedHtml).toContain('text-emerald-400');

    const failedHtml = renderToString(
      <GenerationProgressStepper
        currentPhase="failed"
        failedPhase="verifying"
        errorMessage="Syntax verification failed"
      />,
    );
    expect(failedHtml).toContain('text-rose-400');
    expect(failedHtml).toContain('Game generation failed: Syntax verification failed');
  });
});

describe('ToolInvocationFeed', () => {
  it('renders streaming ToolInvocationCard with violet glow badge and ms timer', () => {
    const html = renderToString(
      <ToolInvocationCard
        item={{
          id: 'tool-1',
          toolName: 'write_file',
          status: 'streaming',
          durationMs: 342,
          path: 'src/main.js',
          label: 'Generating main game loop',
        }}
      />,
    );

    expect(html).toContain('write_file');
    expect(html).toContain('src/main.js');
    expect(html).toContain('Generating main game loop');
    // Violet glow badge for streaming
    expect(html).toContain('border-violet-500/50');
    expect(html).toContain('text-violet-300');
    expect(html).toContain('bg-violet-950/40');
    // Duration timer in ms with font-mono tabular-nums
    expect(html).toContain('342ms');
    expect(html).toContain('tabular-nums');
  });

  it('renders completed with emerald check, retrying with amber wrench, failed with rose alert', () => {
    const completedHtml = renderToString(
      <ToolInvocationCard
        item={{
          id: 'tool-2',
          toolName: 'ast_verify',
          status: 'completed',
          durationMs: 45,
        }}
      />,
    );
    expect(completedHtml).toContain('border-emerald-500/50');
    expect(completedHtml).toContain('text-emerald-400');
    expect(completedHtml).toContain('45ms');

    const retryingHtml = renderToString(
      <ToolInvocationCard
        item={{
          id: 'tool-3',
          toolName: 'patch_file',
          status: 'retrying',
          durationMs: 120,
        }}
      />,
    );
    expect(retryingHtml).toContain('border-amber-500/50');
    expect(retryingHtml).toContain('text-amber-400');

    const failedHtml = renderToString(
      <ToolInvocationCard
        item={{
          id: 'tool-4',
          toolName: 'write_file',
          status: 'failed',
          durationMs: 80,
          error: 'CWE-22 path traversal violation',
        }}
      />,
    );
    expect(failedHtml).toContain('border-rose-500/50');
    expect(failedHtml).toContain('text-rose-400');
    expect(failedHtml).toContain('CWE-22 path traversal violation');
  });

  it('renders diff viewer button and auto-scroll lock toggle', () => {
    const html = renderToString(
      <ToolInvocationFeed
        invocations={[
          {
            id: 'inv-1',
            toolName: 'patch_file',
            status: 'completed',
            diff: '@@ -1,3 +1,4 @@\n-old line\n+new line',
          },
        ]}
      />,
    );

    expect(html).toContain('Auto-scroll');
    expect(html).toContain('View code modifications');
  });
});

describe('GenerationInspector', () => {
  it('renders TokenTelemetryGauge with 80% compaction threshold marker', () => {
    const html = renderToString(
      <TokenTelemetryGauge
        telemetry={{
          usedTokens: 165_000,
          modelLimit: 200_000,
          inputTokens: 150_000,
          outputTokens: 15_000,
          cachedTokens: 120_000,
        }}
      />,
    );

    expect(html).toContain((165000).toLocaleString());
    expect(html).toContain((200000).toLocaleString());
    expect(html).toContain('80% Compaction');
    expect(html).toContain('Pruning Imminent (≥80%)');
    expect(html).toContain('data-testid="compaction-threshold-marker"');
    expect(html).toContain('left:80%');
  });

  it('renders ThinkingBlockViewer with turnIndex, signature, and thinking blocks', () => {
    const html = renderToString(
      <ThinkingBlockViewer
        initialExpanded={true}
        thinkingBlocks={[
          {
            turnIndex: 0,
            signature: 'sig_abc123456789',
            thinking: 'Analyzing arcade physics mechanics for player movement...',
          },
        ]}
      />,
    );

    expect(html).toContain('Turn 1');
    expect(html).toContain('sig: sig_abc123...');
    expect(html).toContain('Analyzing arcade physics mechanics for player movement...');
  });

  it('renders DiagnosticCalloutList with AST line/column pointers and remediation directives', () => {
    const html = renderToString(
      <DiagnosticCalloutList
        diagnostics={[
          {
            filename: 'src/main.js',
            message: 'Unexpected token, expected "," (12:4)',
            line: 12,
            column: 4,
            severity: 'error',
            suggestedRemediation: 'Add missing closing bracket on line 11',
          },
        ]}
      />,
    );

    expect(html).toContain('src/main.js');
    expect(html).toContain('L12:C4');
    expect(html).toContain('Unexpected token');
    expect(html).toContain('💡 Suggested Remediation');
    expect(html).toContain('Add missing closing bracket on line 11');
  });
});

describe('PreviewFrame', () => {
  it('strictly enforces sandbox="allow-scripts allow-forms" with ABSOLUTELY NO allow-same-origin and NO allow-modals', () => {
    const html = renderToString(
      <PreviewFrame previewUrl="https://playforge.internal/preview/test-game" />,
    );

    expect(html).toContain('sandbox="allow-scripts allow-forms"');
    expect(html).not.toContain('allow-same-origin');
    expect(html).not.toContain('allow-modals');
  });

  it('renders shimmer skeleton during code bundling', () => {
    const html = renderToString(<PreviewFrame isBundling={true} />);

    expect(html).toContain('Bundling Game Code...');
    expect(html).toContain('data-testid="bundling-shimmer"');
    // Iframe is not rendered during bundling
    expect(html).not.toContain('sandbox=');
  });
});
