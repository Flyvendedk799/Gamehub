/**
 * enqueueRun — bridges the generation worker and the event bus.
 *
 * Runs `runGeneration` and publishes every agent event to `run:{runId}` on
 * the bus so the API's SSE relay can stream them to the browser. A terminal
 * `run_complete` or `run_error` event is always published last so subscribers
 * know when to close the stream.
 *
 * When the agent pauses at a safe boundary (output.interrupted === true), the
 * function builds a ContinuationPromptInput from the tracked set_todos and the
 * final file state, attaches it to the result, and publishes a `run_paused`
 * event. The caller (BullMQ worker main.ts) persists that state to
 * runs.continuation + inserts a continuation_pending chat row.
 *
 * In production the caller is a BullMQ worker consumer; in dev/test it can
 * be called inline with `InMemoryEventBus` + `InMemoryBlobStore`.
 */
import type { AgentEvent } from '@playforge/agent-core';
import {
  buildContinuationPrompt,
  type ContinuationPromptInput,
  type TodoSnapshot,
} from '@playforge/agent-core';
import { type EventBus, runChannel } from '@playforge/bus';
import type { ModelRef } from '@playforge/shared';
import type { SnapshotStore } from '@playforge/storage';
import { runGeneration, type GenerateFn, type GenerationResult, type WebEngine } from './run-generation';

export interface EnqueueInput {
  runId: string;
  projectId: string;
  prompt: string;
  model: ModelRef;
  apiKey: string;
  engine?: WebEngine;
  /** Manifest key of the previous snapshot to seed the working tree for iteration. */
  parentManifestKey?: string;
  /** Continuation state from a previously paused run — replaces prompt with buildContinuationPrompt. */
  continuation?: ContinuationPromptInput;
}

export interface QueuePorts {
  bus: EventBus;
  store: SnapshotStore;
  /** Injectable agent runner — defaults to the real generateViaAgent. */
  generate?: GenerateFn;
}

export interface EnqueueResult extends GenerationResult {
  /** Set when the agent paused at a safe boundary. Caller persists to DB. */
  pausedContinuation?: ContinuationPromptInput;
}

export async function enqueueRun(
  input: EnqueueInput,
  ports: QueuePorts,
): Promise<EnqueueResult> {
  const channel = runChannel(input.runId);

  // Seed the working tree from the parent snapshot for iteration.
  let initialFiles: Map<string, string> | undefined;
  if (input.parentManifestKey) {
    try {
      const manifest = await ports.store.readManifest(input.parentManifestKey);
      const files = new Map<string, string>();
      const TEXT_PREFIXES = ['text/', 'application/json'];
      for (const [path, entry] of Object.entries(manifest.files)) {
        if (TEXT_PREFIXES.some((p) => entry.contentType.startsWith(p))) {
          const bytes = await ports.store.readFile(manifest, path);
          files.set(path, Buffer.from(bytes).toString());
        }
      }
      if (files.size > 0) initialFiles = files;
    } catch (err) {
      console.warn(`[enqueueRun] could not load parent snapshot ${input.parentManifestKey}: ${String(err)}`);
    }
  }

  // Track the latest set_todos result so we can build a continuation.
  let latestTodos: TodoSnapshot | null = null;

  // Use the continuation prompt when resuming a paused run.
  const effectivePrompt = input.continuation
    ? buildContinuationPrompt(input.continuation)
    : input.prompt;

  try {
    const result = await runGeneration(
      {
        prompt: effectivePrompt,
        model: input.model,
        apiKey: input.apiKey,
        ...(input.engine !== undefined ? { engine: input.engine } : {}),
        ...(initialFiles !== undefined ? { initialFiles } : {}),
      },
      {
        store: ports.store,
        ...(ports.generate !== undefined ? { generate: ports.generate } : {}),
        onEvent: (event: AgentEvent) => {
          // Capture the latest set_todos for continuation building.
          if (
            event.type === 'tool_execution_end' &&
            event.toolName === 'set_todos' &&
            !event.isError &&
            event.result != null
          ) {
            const items = (event.result as Record<string, unknown>)['items'];
            if (Array.isArray(items)) {
              latestTodos = {
                items: items.map((item: unknown) => {
                  const i = item as Record<string, unknown>;
                  return {
                    text: String(i['text'] ?? ''),
                    checked: Boolean(i['checked'] ?? false),
                  };
                }),
              };
            }
          }
          void ports.bus.publish(channel, event);
        },
      },
    );

    // Agent paused cleanly at a safe boundary — build continuation payload.
    if (result.output.interrupted === true) {
      const pausedContinuation: ContinuationPromptInput = {
        todos: latestTodos,
        decisionRecap: result.output.message ?? '',
        fsState: result.fsState,
        originalUserPrompt: input.continuation?.originalUserPrompt ?? input.prompt,
      };
      await ports.bus.publish(channel, { type: 'run_paused' });
      return { ...result, pausedContinuation };
    }

    await ports.bus.publish(channel, { type: 'run_complete' });
    return result;
  } catch (err) {
    await ports.bus.publish(channel, { type: 'run_error', error: String(err) });
    throw err;
  }
}
