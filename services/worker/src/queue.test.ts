/**
 * Offline tests for enqueueRun: verifies that agent events flow from the
 * runGeneration inner call to the event bus, and that terminal events are
 * always published regardless of success or failure.
 */
import type { AgentEvent, GenerateOutput } from '@playforge/agent-core';
import { InMemoryEventBus, runChannel } from '@playforge/bus';
import { InMemoryBlobStore, SnapshotStore } from '@playforge/storage';
import { describe, expect, it } from 'vitest';
import { enqueueRun } from './queue';
import type { GenerateFn } from './run-generation';

function emptyOutput(): GenerateOutput {
  return {
    message: 'done',
    artifacts: [],
    inputTokens: 10,
    outputTokens: 5,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    costUsd: 0.001,
    interrupted: false,
  };
}

const successAgent: GenerateFn = async (_input, deps) => {
  deps.onEvent?.({ type: 'text_delta', text: 'building' } as unknown as AgentEvent);
  await deps.fs?.create('index.html', '<html></html>');
  deps.onEvent?.({ type: 'agent_end' } as unknown as AgentEvent);
  return emptyOutput();
};

const failAgent: GenerateFn = async (_input, _deps) => {
  throw new Error('provider timeout');
};

function makePorts() {
  const bus = new InMemoryEventBus();
  const store = new SnapshotStore(new InMemoryBlobStore());
  return { bus, store };
}

describe('enqueueRun', () => {
  it('publishes agent events then run_complete on success', async () => {
    const { bus, store } = makePorts();
    const runId = 'run_001';
    const received: unknown[] = [];
    await bus.subscribe(runChannel(runId), (msg) => received.push(msg));

    await enqueueRun(
      {
        runId,
        projectId: 'proj_1',
        prompt: 'red square',
        model: { provider: 'anthropic', modelId: 'claude-opus-4-8' },
        apiKey: 'sk-test',
      },
      { bus, store, generate: successAgent },
    );

    const types = received.map((m) => (m as { type: string }).type);
    expect(types).toContain('text_delta');
    expect(types).toContain('agent_end');
    // run_complete is always the last event
    expect(types[types.length - 1]).toBe('run_complete');
  });

  it('publishes run_error and rethrows when the agent fails', async () => {
    const { bus, store } = makePorts();
    const runId = 'run_002';
    const received: unknown[] = [];
    await bus.subscribe(runChannel(runId), (msg) => received.push(msg));

    await expect(
      enqueueRun(
        {
          runId,
          projectId: 'proj_1',
          prompt: 'fail',
          model: { provider: 'anthropic', modelId: 'claude-opus-4-8' },
          apiKey: 'sk-test',
        },
        { bus, store, generate: failAgent },
      ),
    ).rejects.toThrow('provider timeout');

    const types = received.map((m) => (m as { type: string }).type);
    expect(types).toContain('run_error');
    const errEvent = received.find((m) => (m as { type: string }).type === 'run_error') as {
      type: string;
      error: string;
    };
    expect(errEvent.error).toContain('provider timeout');
  });

  it('late subscriber still receives all events via replay', async () => {
    const { bus, store } = makePorts();
    const runId = 'run_003';

    // Run completes before subscriber connects
    await enqueueRun(
      {
        runId,
        projectId: 'proj_1',
        prompt: 'test',
        model: { provider: 'anthropic', modelId: 'claude-opus-4-8' },
        apiKey: 'sk-test',
      },
      { bus, store, generate: successAgent },
    );

    // Late subscriber gets full history (replay semantics)
    const replayed: unknown[] = [];
    await bus.subscribe(runChannel(runId), (msg) => replayed.push(msg));

    const types = replayed.map((m) => (m as { type: string }).type);
    expect(types).toContain('run_complete');
  });
});
