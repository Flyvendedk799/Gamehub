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
import { type GenerateFn, runGeneration } from './run-generation';

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
