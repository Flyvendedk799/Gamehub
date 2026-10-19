import type {
  DiagnosticItem,
  ThinkingBlockPayload,
  TokenTelemetryData,
} from '@/components/GenerationInspector';
import type { GenerationPhase } from '@/components/GenerationProgressStepper';
import type { ToolInvocationItem } from '@/components/ToolInvocationFeed';
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
  let phase: GenerationPhase = isBuilding ? 'analyzing' : 'completed';
  if (hasError) phase = 'failed';

  let reflexionTurn = 1;
  const maxReflexionTurns = 2;

  const invocationsMap = new Map<string, ToolInvocationItem>();
  const thinkingByTurn = new Map<number, { signature?: string; thinking: string }>();
  let currentTurnIndex = 0;
  const diagnostics: DiagnosticItem[] = [];

  const usedTokens = 0;
  const inputTokens = 0;
  const outputTokens = 0;
  const cachedTokens = 0;

  for (const event of events) {
    if (event.type === 'turn_start') {
      currentTurnIndex = event.turnIndex ?? currentTurnIndex;
    }

    if (event.type === 'tool_use') {
      const toolName = event.toolName.toLowerCase();
      if (
        toolName.includes('patch') ||
        toolName.includes('repair') ||
        toolName.includes('reflexion')
      ) {
        phase = 'repairing';
        reflexionTurn = Math.min(maxReflexionTurns, reflexionTurn + 1);
      } else if (
        toolName.includes('verify') ||
        toolName.includes('test') ||
        toolName.includes('ast')
      ) {
        phase = 'verifying';
      } else if (
        toolName.includes('write') ||
        toolName.includes('create') ||
        toolName.includes('edit')
      ) {
        phase = 'writing_code';
      } else if (toolName.includes('spec') || toolName.includes('plan')) {
        phase = 'planning';
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

    if (event.type === 'run_complete') {
      phase = 'completed';
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
    telemetry: {
      usedTokens: usedTokens || (isBuilding ? 45_000 : 12_000),
      modelLimit: 200_000,
      inputTokens,
      outputTokens,
      cachedTokens,
    },
  };
}
