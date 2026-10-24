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
  it('never announces completion when persistence fails', async () => {
    const { bus, store } = makePorts();
    const received: Array<{ type: string }> = [];
    await bus.subscribe(runChannel('settle_failed'), (msg) =>
      received.push(msg as { type: string }),
    );
    await expect(
      enqueueRun(
        {
          runId: 'settle_failed',
          projectId: 'proj_1',
          prompt: 'red square',
          model: { provider: 'anthropic', modelId: 'claude-opus-4-8' },
          apiKey: 'sk-test',
        },
        {
          bus,
          store,
          generate: successAgent,
          settle: async () => {
            throw new Error('database unavailable');
          },
        },
      ),
    ).rejects.toThrow('database unavailable');
    expect(received.map((event) => event.type)).not.toContain('run_complete');
    expect(received.at(-1)?.type).toBe('run_error');
  });

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

  it('numbers a retried job after the events its first attempt stored, and says it restarted', async () => {
    const { bus, store } = makePorts();
    const stored: Array<{ seq: number; event: unknown }> = [];

    await enqueueRun(
      {
        runId: 'run_retry',
        projectId: 'proj_1',
        prompt: 'red square',
        model: { provider: 'anthropic', modelId: 'claude-opus-4-8' },
        apiKey: 'sk-test',
      },
      {
        bus,
        store,
        generate: successAgent,
        nextEventSeq: async () => 9,
        persistEvent: (rec) => {
          stored.push({ seq: rec.seq, event: rec.event });
        },
      },
    );
    await new Promise((r) => setTimeout(r, 0));

    const seqs = stored.map((s) => s.seq);
    expect(Math.min(...seqs)).toBe(9);
    expect(new Set(seqs).size).toBe(seqs.length);
    const first = stored.find((s) => s.seq === 9)?.event as { type?: string; label?: string };
    expect(first.type).toBe('progress');
    expect(first.label).toContain('back up after an interruption');
  });

  it('starts a first attempt at 0 with no restart marker', async () => {
    const { bus, store } = makePorts();
    const stored: number[] = [];
    await enqueueRun(
      {
        runId: 'run_first',
        projectId: 'proj_1',
        prompt: 'red square',
        model: { provider: 'anthropic', modelId: 'claude-opus-4-8' },
        apiKey: 'sk-test',
      },
      {
        bus,
        store,
        generate: successAgent,
        nextEventSeq: async () => 0,
        persistEvent: (rec) => {
          stored.push(rec.seq);
        },
      },
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(Math.min(...stored)).toBe(0);
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
      parentBytes.push(
        deps.getParentArtifactBytes ? await deps.getParentArtifactBytes() : undefined,
      );
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

  // The builder repoints its preview iframe at the project's HEAD the moment it
  // sees `run_complete`, so the HEAD advance (finalizeRun, wired as `settle`)
  // must be committed BEFORE that frame goes out — otherwise the reload serves
  // the previous iteration and "refresh" never shows the newest build.
  it('settles the run BEFORE publishing run_complete', async () => {
    const { bus, store } = makePorts();
    const runId = 'run_settle';
    const order: string[] = [];
    await bus.subscribe(runChannel(runId), (msg) => {
      const t = (msg as { type: string }).type;
      if (t === 'run_complete') order.push('published');
    });

    await enqueueRun(
      {
        runId,
        projectId: 'proj_1',
        prompt: 'red square',
        model: { provider: 'anthropic', modelId: 'claude-opus-4-8' },
        apiKey: 'sk-test',
      },
      {
        bus,
        store,
        generate: successAgent,
        settle: async (result) => {
          // Persistence is async in production (a DB transaction) — a macrotask
          // here proves the publish actually waits rather than merely losing a race.
          await new Promise((r) => setTimeout(r, 5));
          expect(result.snapshot.manifestKey).toBeTruthy();
          order.push('settled');
        },
      },
    );

    expect(order).toEqual(['settled', 'published']);
  });

  it('settles a PAUSED run before publishing run_paused, with the continuation attached', async () => {
    const { bus, store } = makePorts();
    const runId = 'run_settle_paused';
    const order: string[] = [];
    await bus.subscribe(runChannel(runId), (msg) => {
      const t = (msg as { type: string }).type;
      if (t === 'run_paused') order.push('published');
    });

    const pausingAgent: GenerateFn = async (_input, deps) => {
      await deps.fs?.create('index.html', '<html></html>');
      return { ...emptyOutput(), interrupted: true };
    };

    let sawContinuation = false;
    await enqueueRun(
      {
        runId,
        projectId: 'proj_1',
        prompt: 'a long build',
        model: { provider: 'anthropic', modelId: 'claude-opus-4-8' },
        apiKey: 'sk-test',
      },
      {
        bus,
        store,
        generate: pausingAgent,
        settle: async (result) => {
          await new Promise((r) => setTimeout(r, 5));
          sawContinuation = result.pausedContinuation !== undefined;
          order.push('settled');
        },
      },
    );

    expect(sawContinuation).toBe(true);
    expect(order).toEqual(['settled', 'published']);
  });

  it('puts the previous version back when a run fails after showing a draft', async () => {
    const { bus, store } = makePorts();
    const html = '<!doctype html><canvas id="game"></canvas>';
    const parent = await store.write([
      { path: 'index.html', bytes: new TextEncoder().encode(html) },
    ]);
    const calls: Array<{ projectId: string; manifestKey: string }> = [];
    const agent: GenerateFn = async (_input, deps) => {
      await deps.fs?.create('index.html', `${html}<!-- edited -->`);
      return { ...emptyOutput(), hostSummary: 'Here is what changed' };
    };

    await expect(
      enqueueRun(
        {
          runId: 'run_draft_fail',
          projectId: 'proj_1',
          prompt: 'make it better',
          model: { provider: 'anthropic', modelId: 'claude-opus-4-8' },
          apiKey: 'sk-test',
          parentManifestKey: parent.manifestKey,
        },
        {
          bus,
          store,
          generate: agent,
          browserJobs: {
            async runtimeVerify() {
              return { hasGameContract: true, fatalErrors: [] };
            },
            async playtest() {
              return null;
            },
          },
          publishDraft: async (projectId, draft) => {
            calls.push({ projectId, manifestKey: draft.manifestKey });
          },
          settle: async () => {
            throw new Error('db down');
          },
        },
      ),
    ).rejects.toThrow('db down');

    // The draft went up, then the parent version was restored.
    expect(calls).toHaveLength(2);
    expect(calls[0]?.manifestKey).not.toBe(parent.manifestKey);
    expect(calls[1]).toEqual({ projectId: 'proj_1', manifestKey: parent.manifestKey });
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
