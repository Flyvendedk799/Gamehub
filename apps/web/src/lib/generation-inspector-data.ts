import type {
  DiagnosticItem,
  ThinkingBlockPayload,
  TokenTelemetryData,
} from '@/components/GenerationInspector';
import type { GenerationPhase } from '@/components/GenerationProgressStepper';
import type { ToolInvocationItem } from '@/components/ToolInvocationFeed';
import { currentRunEvents, deriveBuildStatus } from './build-status';
import type { SseEvent } from './types';

export interface GenerationDerivedData {
  phase: GenerationPhase;
  reflexionTurn: number;
  maxReflexionTurns: number;
  invocations: ToolInvocationItem[];
  thinkingBlocks: ThinkingBlockPayload[];
  diagnostics: DiagnosticItem[];
  telemetry: TokenTelemetryData;
}

export function deriveGenerationData(
  events: SseEvent[],
  isBuilding: boolean,
  hasError = false,
  errorMessage?: string,
): GenerationDerivedData {
  let phase: GenerationPhase = deriveBuildStatus(events).stage;
  if (!isBuilding && events.length === 0) phase = 'draft';
  if (hasError) phase = 'failed';

  let reflexionTurn = 1;
  const maxReflexionTurns = 2;

  const invocationsMap = new Map<string, ToolInvocationItem>();
  const thinkingByTurn = new Map<number, { signature?: string; thinking: string }>();
  let currentTurnIndex = 0;
  const diagnostics: DiagnosticItem[] = [];

  let hasUsage = false;
  let latestInputTokens: number | undefined;
  let latestOutputTokens: number | undefined;
  let latestTotalTokens: number | undefined;
  let latestCacheReadTokens: number | undefined;
  let latestModelLimit: number | undefined;

  for (const event of currentRunEvents(events)) {
    if (event.type === 'token_usage') {
      hasUsage = true;
      if (typeof event.inputTokens === 'number') latestInputTokens = event.inputTokens;
      if (typeof event.outputTokens === 'number') latestOutputTokens = event.outputTokens;
      if (typeof event.totalTokens === 'number') latestTotalTokens = event.totalTokens;
      if (typeof event.cacheReadTokens === 'number') latestCacheReadTokens = event.cacheReadTokens;
      if (typeof event.modelLimit === 'number') latestModelLimit = event.modelLimit;
    }

    if (event.type === 'turn_start') {
      currentTurnIndex = event.turnIndex ?? currentTurnIndex;
    }

    if (event.type === 'tool_use') {
      if (event.toolName === 'patch_file_reflexion') {
        reflexionTurn = Math.min(maxReflexionTurns, reflexionTurn + 1);
      }

      const id = `${event.toolName}-${event.timestamp}`;
      invocationsMap.set(id, {
        id,
        toolName: event.toolName,
        status: 'streaming',
        label: event.label,
        path: event.path,
        input: event.input,
        diff: typeof event.input?.['diff'] === 'string' ? event.input['diff'] : undefined,
        timestamp: event.timestamp,
      });
    }

    if (event.type === 'tool_result') {
      // Find matching tool invocation
      const matching = Array.from(invocationsMap.values())
        .reverse()
        .find((inv) => inv.toolName === event.toolName && inv.status === 'streaming');

      if (matching) {
        matching.status = event.success ? 'completed' : 'failed';
        if (event.timestamp && matching.timestamp) {
          const start = new Date(matching.timestamp).getTime();
          const end = new Date(event.timestamp).getTime();
          if (!Number.isNaN(start) && !Number.isNaN(end) && end >= start) {
            matching.durationMs = end - start;
          }
        }
      }
    }

    if (event.type === 'thinking_delta') {
      const current = thinkingByTurn.get(currentTurnIndex) ?? { thinking: '' };
      current.thinking += event.delta;
      thinkingByTurn.set(currentTurnIndex, current);
    }

    if (event.type === 'run_error') {
      phase = 'failed';
      diagnostics.push({
        id: `err-${event.timestamp}`,
        filename: 'Build Error',
        message: event.error,
        line: 1,
        column: 0,
        severity: 'error',
      });
    }
  }

  if (errorMessage && diagnostics.length === 0) {
    diagnostics.push({
      id: 'err-prop',
      filename: 'Error',
      message: errorMessage,
      line: 1,
      column: 0,
      severity: 'error',
    });
  }

  // Format thinking blocks
  const thinkingBlocks: ThinkingBlockPayload[] = Array.from(thinkingByTurn.entries()).map(
    ([turnIndex, data]) => ({
      turnIndex,
      signature: data.signature,
      thinking: data.thinking,
    }),
  );

  return {
    phase,
    reflexionTurn,
    maxReflexionTurns,
    invocations: Array.from(invocationsMap.values()),
    thinkingBlocks,
    diagnostics,
    telemetry: hasUsage
      ? {
          usedTokens: latestTotalTokens ?? (latestInputTokens ?? 0) + (latestOutputTokens ?? 0),
          modelLimit: latestModelLimit,
          inputTokens: latestInputTokens,
          outputTokens: latestOutputTokens,
          cachedTokens: latestCacheReadTokens,
        }
      : {
          usedTokens: undefined,
          modelLimit: undefined,
          inputTokens: undefined,
          outputTokens: undefined,
          cachedTokens: undefined,
        },
  };
}
