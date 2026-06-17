/**
 * Offline E2E for the worker orchestration. We inject a fake agent runner that
 * exercises the REAL host dependencies runGeneration wires up (fs WorkingTree,
 * gameMode engine/spec carry-forward, onEvent stream) exactly as the live
 * generateViaAgent would — then assert the snapshot persisted and the stream
 * fired. No provider key, no network: deterministic proof of the wiring.
 */
import type { AgentEvent, GenerateOutput } from '@playforge/agent-core';
import type { GameSpec } from '@playforge/shared';
import { InMemoryBlobStore, SnapshotStore } from '@playforge/storage';
import { describe, expect, it } from 'vitest';
import { ENGINE_SCENE_VALIDATOR, type GenerateFn, runGeneration } from './run-generation';

describe('ENGINE_SCENE_VALIDATOR (#1.1 — the worker now runs a REAL engine lint, not the old no-op)', () => {
  it('flags a Phaser add.image with no matching load.image as ok:false (was always ok:true)', () => {
    const result = ENGINE_SCENE_VALIDATOR('phaser', [
      {
        path: 'game.js',
        content: `class Scene extends Phaser.Scene { create() { this.add.image(100, 100, 'hero'); } }`,
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.engine).toBe('phaser');
    expect(result.issues.some((i) => i.severity === 'error' && i.message.includes('hero'))).toBe(true);
  });
});

const RED_SQUARE = `<!doctype html><html><body>
<canvas id="game"></canvas>
<script type="module">
  import Phaser from 'https://cdn.jsdelivr.net/npm/phaser@3.88.0/+esm';
  new Phaser.Game({ width: 256, height: 256, scene: { create() {
    this.add.rectangle(128, 128, 64, 64, 0xff0000);
  } } });
</script></body></html>`;

function emptyOutput(message: string): GenerateOutput {
  return {
    message,
    artifacts: [],
    inputTokens: 1200,
    outputTokens: 340,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    costUsd: 0.012,
    interrupted: false,
  };
}

/** A fake agent that "builds" a red-square Phaser game the way the real agent
 *  would: declares the engine + spec, writes index.html, narrates via events. */
const fakeAgent: GenerateFn = async (input, deps) => {
  deps.onEvent?.({ type: 'agent_start' } as unknown as AgentEvent);
  const gm = deps.gameMode;
  if (gm) {
    await gm.setEngine('phaser', 'arcade 2D fits a static red square');
    await gm.setSpec?.({ genre: 'sandbox', dimension: '2d' } as unknown as GameSpec);
  }
  await deps.fs?.create('index.html', RED_SQUARE);
  deps.onEvent?.({ type: 'agent_end' } as unknown as AgentEvent);
  return emptyOutput(`Built a red square with ${input.engine ?? 'the chosen engine'}.`);
};

describe('runGeneration (offline E2E)', () => {
  it('runs the agent, persists a snapshot, and streams events', async () => {
    const store = new SnapshotStore(new InMemoryBlobStore());
    const events: AgentEvent[] = [];

    const result = await runGeneration(
      { prompt: 'make a red square', model: { provider: 'anthropic', modelId: 'claude-opus-4-8' }, apiKey: 'sk-test' },
      { store, generate: fakeAgent, onEvent: (e) => events.push(e) },
    );

    // Engine + spec carried forward through the gameMode callbacks.
    expect(result.engine).toBe('phaser');
    expect(result.spec).toMatchObject({ genre: 'sandbox', dimension: '2d' });
    expect(result.fileCount).toBe(1);

    // Snapshot persisted to content-addressed storage; index.html readable back.
    expect(result.snapshot.manifestKey).toBe(`snapshots/${result.snapshot.filesHash}/manifest.json`);
    const bytes = await store.readFile(result.snapshot.manifest, 'index.html');
    expect(new TextDecoder().decode(bytes)).toContain('0xff0000');

    // Stream fired start → end.
    expect(events.map((e) => (e as { type: string }).type)).toEqual(['agent_start', 'agent_end']);

    // Usage surfaced for the credit ledger.
    expect(result.output.inputTokens).toBe(1200);
    expect(result.output.costUsd).toBeCloseTo(0.012);
  });

  it('honors a pre-picked engine and seeds the tree from a remix parent', async () => {
    const store = new SnapshotStore(new InMemoryBlobStore());
    const noopAgent: GenerateFn = async () => emptyOutput('ok');

    const result = await runGeneration(
      {
        prompt: 'iterate',
        model: { provider: 'anthropic', modelId: 'claude-opus-4-8' },
        apiKey: 'sk-test',
        engine: 'three',
        initialFiles: [['index.html', '<canvas></canvas>'], ['src/main.js', 'scene()']],
      },
      { store, generate: noopAgent },
    );

    expect(result.engine).toBe('three');
    expect(result.fileCount).toBe(2);
    const bytes = await store.readFile(result.snapshot.manifest, 'src/main.js');
    expect(new TextDecoder().decode(bytes)).toBe('scene()');
  });
});

describe('runGeneration token ceiling (#18)', () => {
  /** Builds a turn_end AgentEvent carrying a usage block (the real assistant
   *  message shape the agent emits after each model turn). */
  function turnEnd(input: number, output: number): AgentEvent {
    return {
      type: 'turn_end',
      message: { usage: { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output } },
      toolResults: [],
    } as unknown as AgentEvent;
  }

  it('aborts the run signal once turn_end usage exceeds maxTokens', async () => {
    const store = new SnapshotStore(new InMemoryBlobStore());

    // Agent emits two turns: the first under budget, the second over. After the
    // second turn_end the signal should already be aborted.
    let signalAbortedAtSecondTurn = false;
    const meteredAgent: GenerateFn = async (input, deps) => {
      deps.onEvent?.(turnEnd(40_000, 5_000)); // 45k — under 100k budget
      expect(input.signal?.aborted ?? false).toBe(false);
      deps.onEvent?.(turnEnd(90_000, 20_000)); // 110k cumulative — over budget
      signalAbortedAtSecondTurn = input.signal?.aborted ?? false;
      await deps.fs?.create('index.html', RED_SQUARE);
      return emptyOutput('hit ceiling');
    };

    await runGeneration(
      { prompt: 'big game', model: { provider: 'anthropic', modelId: 'claude-opus-4-8' }, apiKey: 'sk-test' },
      { store, generate: meteredAgent, maxTokens: 100_000 },
    );

    expect(signalAbortedAtSecondTurn).toBe(true);
  });

  it('does not abort when usage stays under maxTokens', async () => {
    const store = new SnapshotStore(new InMemoryBlobStore());
    let abortedSeen = false;
    const underBudgetAgent: GenerateFn = async (input, deps) => {
      deps.onEvent?.(turnEnd(10_000, 2_000));
      deps.onEvent?.(turnEnd(20_000, 3_000));
      abortedSeen = input.signal?.aborted ?? false;
      await deps.fs?.create('index.html', RED_SQUARE);
      return emptyOutput('ok');
    };

    await runGeneration(
      { prompt: 'small game', model: { provider: 'anthropic', modelId: 'claude-opus-4-8' }, apiKey: 'sk-test' },
      { store, generate: underBudgetAgent, maxTokens: 100_000 },
    );

    expect(abortedSeen).toBe(false);
  });
});
