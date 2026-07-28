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
import type { WorkingTree } from './working-tree';

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

  it('seeds a refine with the parent snapshot INCLUDING binary assets', async () => {
    const { bus, store } = makePorts();
    const spriteBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]); // PNG-ish
    // A parent snapshot with an editable text file AND a binary sprite.
    const parent = await store.write([
      { path: 'index.html', bytes: new TextEncoder().encode('<!doctype html>') },
      {
        path: 'src/main.js',
        bytes: new TextEncoder().encode(
          "const speed = 1;\nthis.load.image('hero', 'assets/hero.png');",
        ),
      },
      { path: 'assets/hero.png', bytes: spriteBytes },
    ]);

    let seededPaths: string[] = [];
    let seededSprite: Uint8Array | undefined;
    const captureAgent: GenerateFn = async (_input, deps) => {
      const tree = deps.fs as unknown as WorkingTree;
      seededPaths = tree.listDir('');
      seededSprite = tree.toSnapshotInput().find((f) => f.path === 'assets/hero.png')?.bytes;
      // A text-only refine — the historical bug dropped the sprite right here.
      await deps.fs?.strReplace('src/main.js', 'const speed = 1;', 'const speed = 5;');
      deps.onEvent?.({ type: 'agent_end' } as unknown as AgentEvent);
      return emptyOutput();
    };

    await enqueueRun(
      {
        runId: 'run_refine',
        projectId: 'proj_1',
        prompt: 'rename hero to player',
        model: { provider: 'anthropic', modelId: 'claude-opus-4-8' },
        apiKey: 'sk-test',
        parentManifestKey: parent.manifestKey,
      },
      { bus, store, generate: captureAgent },
    );

    // The agent saw the sprite in its workspace (not just the text files).
    expect(seededPaths).toContain('assets/hero.png');
    expect(seededSprite).toBeDefined();
    expect(Buffer.from(seededSprite!)).toEqual(Buffer.from(spriteBytes));
  });

  it('marks a parent-seeded run as editMode + wires the destructive-edit guard; fresh run does neither', async () => {
    const { bus, store } = makePorts();
    const parentHtml = '<!doctype html><body>a fuller parent document</body>';
    const parent = await store.write([
      { path: 'index.html', bytes: new TextEncoder().encode(parentHtml) },
    ]);

    const captured: Array<boolean | undefined> = [];
    const parentBytes: Array<number | null | undefined> = [];
    const captureAgent: GenerateFn = async (input, deps) => {
      captured.push((input as { editMode?: boolean }).editMode);
      parentBytes.push(deps.getParentArtifactBytes ? await deps.getParentArtifactBytes() : undefined);
      await deps.fs?.create('index.html', '<html></html>');
      return emptyOutput();
    };

    // A refine (seeded from a parent) → editMode true even on turn 0.
    await enqueueRun(
      {
        runId: 'run_edit',
        projectId: 'proj_1',
        prompt: 'make it faster',
        model: { provider: 'anthropic', modelId: 'claude-opus-4-8' },
        apiKey: 'sk-test',
        parentManifestKey: parent.manifestKey,
      },
      { bus, store, generate: captureAgent },
    );
    // A first-shot build (no parent) → editMode left unset (history-based).
    await enqueueRun(
      {
        runId: 'run_fresh',
        projectId: 'proj_1',
        prompt: 'a platformer',
        model: { provider: 'anthropic', modelId: 'claude-opus-4-8' },
        apiKey: 'sk-test',
      },
      { bus, store, generate: captureAgent },
    );

    expect(captured[0]).toBe(true);
    expect(captured[1]).toBeUndefined();
    // Refine wires the guard, returning the PARENT entry size (captured before edits).
    expect(parentBytes[0]).toBe(parentHtml.length);
    // Fresh build has no parent → guard left unwired.
    expect(parentBytes[1]).toBeUndefined();
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
