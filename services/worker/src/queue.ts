/**
 * enqueueRun — bridges the generation worker and the event bus.
 *
 * Runs `runGeneration` and publishes every agent event to `run:{runId}` on
 * the bus so the API's SSE relay can stream them to the browser. A terminal
 * `run_complete` or `run_error` event is always published last so subscribers
 * know when to close the stream.
 *
 * In production the caller is a BullMQ worker consumer; in dev/test it can
 * be called inline with `InMemoryEventBus` + `InMemoryBlobStore`.
 */
import type { AgentEvent } from '@playforge/agent-core';
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
}

export interface QueuePorts {
  bus: EventBus;
  store: SnapshotStore;
  /** Injectable agent runner — defaults to the real generateViaAgent. */
  generate?: GenerateFn;
}

export async function enqueueRun(
  input: EnqueueInput,
  ports: QueuePorts,
): Promise<GenerationResult> {
  const channel = runChannel(input.runId);
  try {
    const result = await runGeneration(
      {
        prompt: input.prompt,
        model: input.model,
        apiKey: input.apiKey,
        ...(input.engine !== undefined ? { engine: input.engine } : {}),
      },
      {
        store: ports.store,
        ...(ports.generate !== undefined ? { generate: ports.generate } : {}),
        onEvent: (event: AgentEvent) => {
          void ports.bus.publish(channel, event);
        },
      },
    );
    await ports.bus.publish(channel, { type: 'run_complete' });
    return result;
  } catch (err) {
    await ports.bus.publish(channel, { type: 'run_error', error: String(err) });
    throw err;
  }
}
