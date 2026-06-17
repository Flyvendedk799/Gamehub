/**
 * Offline E2E for the worker orchestration. We inject a fake agent runner that
 * exercises the REAL host dependencies runGeneration wires up (fs WorkingTree,
 * gameMode engine/spec carry-forward, onEvent stream) exactly as the live
 * generateViaAgent would — then assert the snapshot persisted and the stream
 * fired. No provider key, no network: deterministic proof of the wiring.
 */
import type { AgentEvent, GenerateOutput, PlaytestStep } from '@playforge/agent-core';
import type { GameSpec } from '@playforge/shared';
import { InMemoryBlobStore, SnapshotStore } from '@playforge/storage';
import { describe, expect, it } from 'vitest';
import {
  type BrowserJobsPort,
  ENGINE_SCENE_VALIDATOR,
  type GenerateFn,
  type PlaytestVerdict,
  type RuntimeVerifyVerdict,
  runGeneration,
} from './run-generation';

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

describe('runGeneration browser-jobs wiring (#1.4 — out-of-process runtimeVerify + playtester)', () => {
  /** A stub browser-jobs port whose verdicts the test controls — stands in for
   *  the real round-trip to the browser-worker pool. */
  function stubBrowserJobs(opts: {
    runtimeVerify?: RuntimeVerifyVerdict | null;
    playtest?: PlaytestVerdict | null;
  }): BrowserJobsPort & { calls: { verify: string[]; playtest: PlaytestStep[][] } } {
    const calls = { verify: [] as string[], playtest: [] as PlaytestStep[][] };
    return {
      calls,
      async runtimeVerify(html) {
        calls.verify.push(html);
        return opts.runtimeVerify ?? null;
      },
      async playtest(_html, steps) {
        calls.playtest.push([...steps]);
        return opts.playtest ?? null;
      },
    };
  }

  it('a throwing boot makes the injected runtimeVerify report errors (done → has_errors, not force-accept)', async () => {
    const store = new SnapshotStore(new InMemoryBlobStore());
    const browserJobs = stubBrowserJobs({
      // Browser-worker reports the game threw on boot and never set window.__game.
      runtimeVerify: { hasGameContract: false, fatalErrors: ['Uncaught Error: boot blew up'] },
    });

    let runtimeErrors: Array<{ message: string }> = [];
    let runtimeVerifyWasWired = false;
    const agent: GenerateFn = async (_input, deps) => {
      await deps.fs?.create('index.html', RED_SQUARE);
      // The agent's `done` tool calls deps.runtimeVerify(source); emulate that.
      if (deps.runtimeVerify) {
        runtimeVerifyWasWired = true;
        runtimeErrors = await deps.runtimeVerify('<html>broken</html>');
      }
      return emptyOutput('built');
    };

    await runGeneration(
      { prompt: 'broken game', model: { provider: 'anthropic', modelId: 'claude-opus-4-8' }, apiKey: 'sk-test' },
      { store, generate: agent, browserJobs },
    );

    expect(runtimeVerifyWasWired).toBe(true);
    expect(browserJobs.calls.verify).toHaveLength(1);
    // The throwing boot surfaces as errors → done would report status='has_errors'.
    expect(runtimeErrors.length).toBeGreaterThan(0);
    expect(runtimeErrors.some((e) => e.message.includes('boot blew up'))).toBe(true);
    // And the no-__game verdict adds the explicit "did not boot" advisory.
    expect(runtimeErrors.some((e) => e.message.includes('did not boot'))).toBe(true);
  });

  it('a clean runtimeVerify verdict yields no errors (done accepts)', async () => {
    const store = new SnapshotStore(new InMemoryBlobStore());
    const browserJobs = stubBrowserJobs({
      runtimeVerify: { hasGameContract: true, fatalErrors: [] },
    });

    let runtimeErrors: Array<{ message: string }> = [];
    const agent: GenerateFn = async (_input, deps) => {
      await deps.fs?.create('index.html', RED_SQUARE);
      if (deps.runtimeVerify) runtimeErrors = await deps.runtimeVerify(RED_SQUARE);
      return emptyOutput('ok');
    };

    await runGeneration(
      { prompt: 'good game', model: { provider: 'anthropic', modelId: 'claude-opus-4-8' }, apiKey: 'sk-test' },
      { store, generate: agent, browserJobs },
    );

    expect(runtimeErrors).toEqual([]);
  });

  it('the gameMode.playtester is wired and maps the verdict to PlaytesterOutput', async () => {
    const store = new SnapshotStore(new InMemoryBlobStore());
    const steps: PlaytestStep[] = [{ kind: 'key', code: 'KeyD', frames: 20 }];
    const browserJobs = stubBrowserJobs({
      playtest: {
        hasGameContract: true,
        hasDebugContract: true,
        baselineSnapshot: { x: 0 },
        steps: [{ step: steps[0]!, snapshotAfter: { x: 20 }, errors: [] }],
        bootErrors: [],
      },
    });

    let playtesterWired = false;
    let output: unknown = null;
    const agent: GenerateFn = async (_input, deps) => {
      await deps.fs?.create('index.html', RED_SQUARE);
      const playtester = deps.gameMode?.playtester;
      if (playtester) {
        playtesterWired = true;
        output = await playtester({ artifactSource: RED_SQUARE, viewport: 'desktop', steps });
      }
      return emptyOutput('ok');
    };

    await runGeneration(
      { prompt: 'movement game', model: { provider: 'anthropic', modelId: 'claude-opus-4-8' }, apiKey: 'sk-test' },
      { store, generate: agent, browserJobs },
    );

    expect(playtesterWired).toBe(true);
    expect(browserJobs.calls.playtest).toEqual([steps]);
    expect(output).toMatchObject({
      hasDebugContract: true,
      baselineSnapshot: { x: 0 },
      bootErrors: [],
    });
    // The +x-on-KeyD movement is visible in the mapped trace.
    const out = output as { steps: Array<{ snapshotAfter: { x: number } }> };
    expect(out.steps[0]!.snapshotAfter.x).toBe(20);
  });

  it('without a browser-jobs port, runtimeVerify + playtester are NOT wired (offline fallback)', async () => {
    const store = new SnapshotStore(new InMemoryBlobStore());
    let runtimeVerifyWired = false;
    let playtesterWired = false;
    const agent: GenerateFn = async (_input, deps) => {
      await deps.fs?.create('index.html', RED_SQUARE);
      runtimeVerifyWired = deps.runtimeVerify !== undefined;
      playtesterWired = deps.gameMode?.playtester !== undefined;
      return emptyOutput('ok');
    };

    await runGeneration(
      { prompt: 'offline game', model: { provider: 'anthropic', modelId: 'claude-opus-4-8' }, apiKey: 'sk-test' },
      { store, generate: agent },
    );

    expect(runtimeVerifyWired).toBe(false);
    expect(playtesterWired).toBe(false);
  });

  it('a null verdict (queue down) degrades gracefully — no errors, empty playtest', async () => {
    const store = new SnapshotStore(new InMemoryBlobStore());
    const browserJobs = stubBrowserJobs({ runtimeVerify: null, playtest: null });

    let runtimeErrors: Array<{ message: string }> = [];
    let playtestOut: { bootErrors: ReadonlyArray<string> } | null = null;
    const agent: GenerateFn = async (_input, deps) => {
      await deps.fs?.create('index.html', RED_SQUARE);
      if (deps.runtimeVerify) runtimeErrors = await deps.runtimeVerify(RED_SQUARE);
      const playtester = deps.gameMode?.playtester;
      if (playtester) {
        playtestOut = await playtester({
          artifactSource: RED_SQUARE,
          viewport: 'desktop',
          steps: [{ kind: 'wait', frames: 3 }],
        });
      }
      return emptyOutput('ok');
    };

    await runGeneration(
      { prompt: 'queue down', model: { provider: 'anthropic', modelId: 'claude-opus-4-8' }, apiKey: 'sk-test' },
      { store, generate: agent, browserJobs },
    );

    // runtimeVerify with a null verdict must NOT block done (no evidence ≠ failure).
    expect(runtimeErrors).toEqual([]);
    // playtester with a null verdict surfaces an infra-unavailable boot error.
    expect(playtestOut).not.toBeNull();
    expect(playtestOut!.bootErrors.length).toBeGreaterThan(0);
  });
});
