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
  isVerifyInlineAssetNoise,
  runGeneration,
  validateControlsManifest,
} from './run-generation';

describe('isVerifyInlineAssetNoise (WS-C — drop inlining harness artifacts)', () => {
  it('matches the XHR/asset-load failures inlining produces, not real game errors', () => {
    expect(
      isVerifyInlineAssetNoise("Failed to execute 'open' on 'XMLHttpRequest': Invalid URL"),
    ).toBe(true);
    expect(isVerifyInlineAssetNoise('Failed to load resource: 404')).toBe(true);
    expect(isVerifyInlineAssetNoise("TypeError: Cannot read property 'x' of undefined")).toBe(
      false,
    );
    expect(isVerifyInlineAssetNoise('window.__game never appeared')).toBe(false);
  });
});

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
    expect(result.issues.some((i) => i.severity === 'error' && i.message.includes('hero'))).toBe(
      true,
    );
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
      {
        prompt: 'make a red square',
        model: { provider: 'anthropic', modelId: 'claude-opus-4-8' },
        apiKey: 'sk-test',
      },
      { store, generate: fakeAgent, onEvent: (e) => events.push(e) },
    );

    // Engine + spec carried forward through the gameMode callbacks.
    expect(result.engine).toBe('phaser');
    expect(result.spec).toMatchObject({ genre: 'sandbox', dimension: '2d' });
    // 2 files: the stub agent's index.html + the premium starter src/main.js that
    // setEngine seeds the moment the engine is pinned (premium pivot). A real agent
    // edits that seeded entry into its game; this minimal stub leaves it in place.
    expect(result.fileCount).toBe(2);

    // Snapshot persisted to content-addressed storage; index.html readable back.
    expect(result.snapshot.manifestKey).toBe(
      `snapshots/${result.snapshot.filesHash}/manifest.json`,
    );
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
        initialFiles: [
          ['index.html', '<canvas></canvas>'],
          ['src/main.js', 'scene()'],
        ],
      },
      { store, generate: noopAgent },
    );

    expect(result.engine).toBe('three');
    expect(result.fileCount).toBe(2);
    const bytes = await store.readFile(result.snapshot.manifest, 'src/main.js');
    expect(new TextDecoder().decode(bytes)).toBe('scene()');
  });

  it('surfaces the agent ask_user question on the result when the run pauses (WS-D)', async () => {
    const store = new SnapshotStore(new InMemoryBlobStore());
    const askingAgent: GenerateFn = async (_input, deps) => {
      await deps.fs?.create('index.html', RED_SQUARE);
      // The real tool calls deps.onAskUser; the agent loop then pauses via
      // getContinuationHint → interrupted. We simulate that boundary here.
      deps.onAskUser?.('Endless or a finish line?');
      return { ...emptyOutput('asked a question'), interrupted: true };
    };

    const result = await runGeneration(
      {
        prompt: 'make a racing game',
        model: { provider: 'openai', modelId: 'o4-mini' },
        apiKey: 'sk-test',
      },
      { store, generate: askingAgent },
    );

    expect(result.output.interrupted).toBe(true);
    expect(result.pendingQuestion).toBe('Endless or a finish line?');
  });
});

describe('runGeneration generated JavaScript syntax gate', () => {
  it('rejects duplicate top-level declarations before persisting a completed snapshot', async () => {
    const store = new SnapshotStore(new InMemoryBlobStore());
    const brokenAgent: GenerateFn = async (_input, deps) => {
      await deps.fs?.create(
        'index.html',
        '<!doctype html><script type="module" src="src/main.js"></script>',
      );
      await deps.fs?.create(
        'src/main.js',
        "import * as Phaser from 'phaser';\nlet timer;\nlet timer;",
      );
      return emptyOutput('broken');
    };

    await expect(
      runGeneration(
        {
          prompt: 'make a timer game',
          model: { provider: 'openai', modelId: 'o4-mini' },
          apiKey: 'sk-test',
        },
        { store, generate: brokenAgent },
      ),
    ).rejects.toThrow(/Generated JavaScript syntax check failed[\s\S]*src\/main\.js[\s\S]*timer/);
  });
});

describe('runGeneration token ceiling (#18)', () => {
  /** Builds a turn_end AgentEvent carrying a usage block (the real assistant
   *  message shape the agent emits after each model turn). */
  function turnEnd(input: number, output: number): AgentEvent {
    return {
      type: 'turn_end',
      message: {
        usage: { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output },
      },
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
      {
        prompt: 'big game',
        model: { provider: 'anthropic', modelId: 'claude-opus-4-8' },
        apiKey: 'sk-test',
      },
      { store, generate: meteredAgent, maxTokens: 100_000 },
    );

    expect(signalAbortedAtSecondTurn).toBe(true);
  });

  it('aborts on CUMULATIVE usage even when every single turn is under budget (H1)', async () => {
    const store = new SnapshotStore(new InMemoryBlobStore());

    // Each turn (40k) is individually under the 100k ceiling, but three of them
    // sum to 120k. The old per-turn check never tripped here — letting a
    // many-turn run spend an unbounded multiple of the budget. The fix sums
    // across turns, so the signal aborts once the running total crosses 100k.
    let abortedByTurn3 = false;
    const dripAgent: GenerateFn = async (input, deps) => {
      deps.onEvent?.(turnEnd(35_000, 5_000)); // 40k total → cum 40k
      expect(input.signal?.aborted ?? false).toBe(false);
      deps.onEvent?.(turnEnd(35_000, 5_000)); // 40k total → cum 80k
      expect(input.signal?.aborted ?? false).toBe(false);
      deps.onEvent?.(turnEnd(35_000, 5_000)); // 40k total → cum 120k > 100k
      abortedByTurn3 = input.signal?.aborted ?? false;
      await deps.fs?.create('index.html', RED_SQUARE);
      return emptyOutput('cumulative ceiling');
    };

    await runGeneration(
      {
        prompt: 'long game',
        model: { provider: 'anthropic', modelId: 'claude-opus-4-8' },
        apiKey: 'sk-test',
      },
      { store, generate: dripAgent, maxTokens: 100_000 },
    );

    expect(abortedByTurn3).toBe(true);
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
      {
        prompt: 'small game',
        model: { provider: 'anthropic', modelId: 'claude-opus-4-8' },
        apiKey: 'sk-test',
      },
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
      {
        prompt: 'broken game',
        model: { provider: 'anthropic', modelId: 'claude-opus-4-8' },
        apiKey: 'sk-test',
      },
      // maxRepairRounds:0 keeps this focused on the DONE gate — otherwise the
      // loop's (now spec-independent) boot check would see the failing boot and
      // spend repair rounds, which the boot-and-repair suite covers separately.
      { store, generate: agent, browserJobs, maxRepairRounds: 0 },
    );

    expect(runtimeVerifyWasWired).toBe(true);
    // Booted twice now: once by the agent's done gate, once by the loop's boot
    // check (which no longer skips spec-less games).
    expect(browserJobs.calls.verify).toHaveLength(2);
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
      {
        prompt: 'good game',
        model: { provider: 'anthropic', modelId: 'claude-opus-4-8' },
        apiKey: 'sk-test',
      },
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
      {
        prompt: 'movement game',
        model: { provider: 'anthropic', modelId: 'claude-opus-4-8' },
        apiKey: 'sk-test',
      },
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
      {
        prompt: 'offline game',
        model: { provider: 'anthropic', modelId: 'claude-opus-4-8' },
        apiKey: 'sk-test',
      },
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
      {
        prompt: 'queue down',
        model: { provider: 'anthropic', modelId: 'claude-opus-4-8' },
        apiKey: 'sk-test',
      },
      { store, generate: agent, browserJobs },
    );

    // runtimeVerify with a null verdict must NOT block done (no evidence ≠ failure).
    expect(runtimeErrors).toEqual([]);
    // playtester with a null verdict surfaces an infra-unavailable boot error.
    expect(playtestOut).not.toBeNull();
    expect(playtestOut!.bootErrors.length).toBeGreaterThan(0);
  });
});

describe('runGeneration boot-and-repair loop (#1.6 — bounded, deterministic verdict)', () => {
  /** A topdown_arcade game spec with a real fail state → completable, so the
   *  predicate gate is live. */
  const TOPDOWN_SPEC = {
    schemaVersion: 1,
    genre: 'topdown_arcade',
    dimensions: '2d',
    perspective: 'top_down',
    cameraKind: 'follow_2d',
    primaryInputs: ['keyboard'],
    numActors: 1,
    winCondition: 'Reach the exit tile.',
    loseCondition: 'Touch an enemy.',
    features: {},
  } as unknown as GameSpec;

  /** A trace whose WASD deltas satisfy the topdown playbook predicates:
   *  W → y down, S → y up, A → x left, D → x right. Maps onto the browser-
   *  worker PlaytestVerdict shape (baseline + per-step snapshotAfter). */
  function passingPlaytest(): PlaytestVerdict {
    return {
      hasGameContract: true,
      hasDebugContract: true,
      baselineSnapshot: { playerPos: { x: 100, y: 100 } },
      steps: [
        {
          step: { kind: 'key', code: 'KeyW' },
          snapshotAfter: { playerPos: { x: 100, y: 70 } },
          errors: [],
        },
        {
          step: { kind: 'key', code: 'KeyS' },
          snapshotAfter: { playerPos: { x: 100, y: 110 } },
          errors: [],
        },
        {
          step: { kind: 'key', code: 'KeyA' },
          snapshotAfter: { playerPos: { x: 70, y: 110 } },
          errors: [],
        },
        {
          step: { kind: 'key', code: 'KeyD' },
          snapshotAfter: { playerPos: { x: 110, y: 110 } },
          errors: [],
        },
      ],
      bootErrors: [],
    };
  }

  /** The c44763af sign-error class: pressing D moves the player -x. Fails the
   *  D → +x predicate deterministically. */
  function invertedPlaytest(): PlaytestVerdict {
    const v = passingPlaytest();
    return {
      ...v,
      steps: [
        v.steps[0]!,
        v.steps[1]!,
        v.steps[2]!,
        {
          step: { kind: 'key', code: 'KeyD' },
          snapshotAfter: { playerPos: { x: 40, y: 110 } },
          errors: [],
        },
      ],
    };
  }

  /** A browser-jobs stub whose playtest verdicts come from a queue (one per
   *  repair round); the last entry is reused once the queue drains. runtime-
   *  verify is always clean here so only the predicate gate decides. */
  function queuedBrowserJobs(playtests: PlaytestVerdict[]): BrowserJobsPort & {
    playtestCalls: number;
  } {
    let idx = 0;
    return {
      playtestCalls: 0,
      async runtimeVerify() {
        return { hasGameContract: true, fatalErrors: [] } satisfies RuntimeVerifyVerdict;
      },
      async playtest(_html, _steps) {
        this.playtestCalls += 1;
        const v = playtests[Math.min(idx, playtests.length - 1)] ?? null;
        idx += 1;
        return v;
      },
    };
  }

  /** An agent that declares a topdown spec and writes a real index.html. The
   *  per-call `onRound` hook lets a test observe how many times the agent was
   *  re-invoked (round 0 + repair rounds). */
  function specAgent(onRound?: (input: { history: unknown[] }) => void): GenerateFn {
    return async (input, deps) => {
      onRound?.({ history: input.history as unknown[] });
      await deps.gameMode?.setSpec?.(TOPDOWN_SPEC);
      await deps.fs?.create('index.html', RED_SQUARE);
      return emptyOutput('built a topdown game');
    };
  }

  it('a PASSING playtest ships with 0 repair rounds and shipReason=passed', async () => {
    const store = new SnapshotStore(new InMemoryBlobStore());
    const browserJobs = queuedBrowserJobs([passingPlaytest()]);
    let rounds = 0;
    const agent = specAgent(() => {
      rounds += 1;
    });

    const result = await runGeneration(
      {
        prompt: 'topdown game',
        model: { provider: 'anthropic', modelId: 'claude-opus-4-8' },
        apiKey: 'sk-test',
      },
      { store, generate: agent, browserJobs },
    );

    expect(result.repairRounds).toBe(0);
    expect(result.shipReason).toBe('passed');
    expect(rounds).toBe(1); // agent invoked once, no repair
  });

  it('a FAILING playtest triggers exactly one repair round, then a fixed playtest ships', async () => {
    const store = new SnapshotStore(new InMemoryBlobStore());
    // Round 0 inverted (fails) → repair; round 1 passes → ship.
    const browserJobs = queuedBrowserJobs([invertedPlaytest(), passingPlaytest()]);
    const promptsSeen: string[] = [];
    const agent: GenerateFn = async (input, deps) => {
      promptsSeen.push(input.prompt);
      await deps.gameMode?.setSpec?.(TOPDOWN_SPEC);
      await deps.fs?.create('index.html', RED_SQUARE);
      return emptyOutput('built');
    };

    const result = await runGeneration(
      {
        prompt: 'topdown game',
        model: { provider: 'anthropic', modelId: 'claude-opus-4-8' },
        apiKey: 'sk-test',
      },
      { store, generate: agent, browserJobs },
    );

    expect(result.repairRounds).toBe(1);
    expect(result.shipReason).toBe('passed');
    // The repair round was re-invoked with a SPECIFIC instruction naming the field.
    expect(promptsSeen).toHaveLength(2);
    expect(promptsSeen[0]).toBe('topdown game');
    expect(promptsSeen[1]).toContain('playerPos.x');
    expect(promptsSeen[1]!.toLowerCase()).not.toContain('try again');
    // Two playtest verdicts gathered (one per attempt).
    expect(browserJobs.playtestCalls).toBe(2);
  });

  it('a BLANK-render runtime verdict (renderedNonBlank=false) triggers a repair round (premium non-blank gate)', async () => {
    const store = new SnapshotStore(new InMemoryBlobStore());
    let rounds = 0;
    const agent = specAgent(() => {
      rounds += 1;
    });
    // Round 0 (rounds===1): booted but BLANK → repair. Round 1 (rounds===2): renders → ship.
    // Keyed on the round so it's robust to multiple runtimeVerify calls per round.
    const browserJobs: BrowserJobsPort = {
      async runtimeVerify() {
        return {
          hasGameContract: true,
          fatalErrors: [],
          renderedNonBlank: !(rounds <= 1),
        } satisfies RuntimeVerifyVerdict;
      },
      async playtest() {
        return passingPlaytest();
      },
    };

    const result = await runGeneration(
      {
        prompt: 'topdown game',
        model: { provider: 'anthropic', modelId: 'claude-opus-4-8' },
        apiKey: 'sk-test',
      },
      { store, generate: agent, browserJobs },
    );

    expect(result.repairRounds).toBe(1);
    expect(rounds).toBe(2); // re-invoked once to fix the blank render
  });

  it('renderedNonBlank=undefined (abstain — WebGL/old node) does NOT trigger a blank repair', async () => {
    const store = new SnapshotStore(new InMemoryBlobStore());
    // Booted, clean, abstained on blank-check, passing playtest → ships with 0 repairs.
    const browserJobs = queuedBrowserJobs([passingPlaytest()]);
    let rounds = 0;
    const agent = specAgent(() => {
      rounds += 1;
    });

    const result = await runGeneration(
      {
        prompt: 'topdown game',
        model: { provider: 'anthropic', modelId: 'claude-opus-4-8' },
        apiKey: 'sk-test',
      },
      { store, generate: agent, browserJobs },
    );

    // queuedBrowserJobs.runtimeVerify omits renderedNonBlank (undefined) → no blank fatal.
    expect(result.repairRounds).toBe(0);
    expect(result.shipReason).toBe('passed');
  });

  it('a persistently FAILING playtest stops at the ceiling with shipReason=repair_exhausted', async () => {
    const store = new SnapshotStore(new InMemoryBlobStore());
    // Always inverted — the agent never fixes it. Default budget = 2 rounds.
    const browserJobs = queuedBrowserJobs([invertedPlaytest()]);
    let rounds = 0;
    const agent = specAgent(() => {
      rounds += 1;
    });

    const result = await runGeneration(
      {
        prompt: 'broken topdown',
        model: { provider: 'anthropic', modelId: 'claude-opus-4-8' },
        apiKey: 'sk-test',
      },
      { store, generate: agent, browserJobs },
    );

    expect(result.repairRounds).toBe(2); // DEFAULT_MAX_REPAIR_ROUNDS
    expect(result.shipReason).toBe('repair_exhausted');
    expect(rounds).toBe(3); // round 0 + 2 repair rounds
  });

  it('honors a custom maxRepairRounds ceiling (clamped to the hard ceiling of 3)', async () => {
    const store = new SnapshotStore(new InMemoryBlobStore());
    const browserJobs = queuedBrowserJobs([invertedPlaytest()]);
    let rounds = 0;
    const agent = specAgent(() => {
      rounds += 1;
    });

    const result = await runGeneration(
      {
        prompt: 'broken topdown',
        model: { provider: 'anthropic', modelId: 'claude-opus-4-8' },
        apiKey: 'sk-test',
      },
      { store, generate: agent, browserJobs, maxRepairRounds: 99 },
    );

    expect(result.repairRounds).toBe(3); // capped at MAX_REPAIR_ROUNDS_CEILING
    expect(result.shipReason).toBe('repair_exhausted');
    expect(rounds).toBe(4);
  });

  it('maxRepairRounds=0 disables the loop — a failing playtest ships with repair_exhausted, 0 rounds', async () => {
    const store = new SnapshotStore(new InMemoryBlobStore());
    const browserJobs = queuedBrowserJobs([invertedPlaytest()]);
    let rounds = 0;
    const agent = specAgent(() => {
      rounds += 1;
    });

    const result = await runGeneration(
      {
        prompt: 'topdown',
        model: { provider: 'anthropic', modelId: 'claude-opus-4-8' },
        apiKey: 'sk-test',
      },
      { store, generate: agent, browserJobs, maxRepairRounds: 0 },
    );

    expect(result.repairRounds).toBe(0);
    expect(result.shipReason).toBe('repair_exhausted');
    expect(rounds).toBe(1);
  });

  it('a SPEC-LESS game that fails to boot still gets a repair round (boot check is NOT gated on a declared spec)', async () => {
    // Regression: a quick "fix this" edit to a game that never declared a spec
    // (genre=n/a) used to bail BEFORE the boot check → it shipped no_verdict,
    // unbooted, so a load crash went out unnoticed. Now the boot check runs
    // regardless and a crash earns a repair round.
    const store = new SnapshotStore(new InMemoryBlobStore());
    let verifyCall = 0;
    const browserJobs: BrowserJobsPort = {
      async runtimeVerify() {
        verifyCall += 1;
        // Round 0 boots broken (window.__game never appears); the repair boots clean.
        return verifyCall === 1
          ? { hasGameContract: false, fatalErrors: ['Uncaught Error: boot blew up'] }
          : { hasGameContract: true, fatalErrors: [] };
      },
      async playtest() {
        return null;
      },
    };
    let rounds = 0;
    // Agent writes index.html but NEVER declares a spec → state.spec stays null.
    const agent: GenerateFn = async (_input, deps) => {
      rounds += 1;
      await deps.fs?.create('index.html', RED_SQUARE);
      return emptyOutput('fix this — no spec declared');
    };

    const result = await runGeneration(
      {
        prompt: 'fix this',
        model: { provider: 'anthropic', modelId: 'claude-opus-4-8' },
        apiKey: 'sk-test',
      },
      { store, generate: agent, browserJobs },
    );

    expect(result.spec).toBeNull(); // genuinely spec-less
    expect(rounds).toBe(2); // round 0 + ONE repair round (was 1 — shipped unbooted — before the fix)
    expect(result.repairRounds).toBe(1);
  });

  // v3.1 — staged-unused (import→use gap) driver: a skill written to src/engine/
  // but never imported+called must force one wire-or-delete round before shipping.
  const wireAgent = (wireOnRound: number | null) => {
    let rounds = 0;
    const fn: GenerateFn = async (_input, deps) => {
      rounds += 1;
      await deps.gameMode?.setSpec?.(TOPDOWN_SPEC);
      await deps.fs?.create('index.html', RED_SQUARE);
      await deps.fs?.create(
        'src/engine/wave-spawner.js',
        'export function createWaveSystem(){ return { update(){} }; }',
      );
      const wired = wireOnRound !== null && rounds >= wireOnRound;
      await deps.fs?.create(
        'src/main.js',
        wired
          ? "import { createWaveSystem } from './engine/wave-spawner.js';\nconst w = createWaveSystem();\nw.update();"
          : 'let score = 0; // hand-rolled, never imports the skill',
      );
      return emptyOutput(`round ${rounds}`);
    };
    return { fn, rounds: () => rounds };
  };

  it('v3.1: a staged-unused skill forces ONE wire-or-delete round, then ships passed', async () => {
    const store = new SnapshotStore(new InMemoryBlobStore());
    const browserJobs = queuedBrowserJobs([passingPlaytest(), passingPlaytest()]);
    const agent = wireAgent(2); // unwired on round 1, wired on the repair round
    const result = await runGeneration(
      {
        prompt: 'topdown',
        model: { provider: 'anthropic', modelId: 'claude-opus-4-8' },
        apiKey: 'sk-test',
      },
      { store, generate: agent.fn, browserJobs },
    );
    expect(agent.rounds()).toBe(2); // the staged-unused round re-invoked the agent
    expect(result.repairRounds).toBe(1);
    expect(result.shipReason).toBe('passed');
  });

  it('v3.1: a properly-wired skill does NOT trigger an extra round (no false-fire)', async () => {
    const store = new SnapshotStore(new InMemoryBlobStore());
    const browserJobs = queuedBrowserJobs([passingPlaytest()]);
    const agent = wireAgent(1); // wired from the first round
    const result = await runGeneration(
      {
        prompt: 'topdown',
        model: { provider: 'anthropic', modelId: 'claude-opus-4-8' },
        apiKey: 'sk-test',
      },
      { store, generate: agent.fn, browserJobs },
    );
    expect(agent.rounds()).toBe(1);
    expect(result.repairRounds).toBe(0);
    expect(result.shipReason).toBe('passed');
  });

  it('v3.1 (P9): a playbook game with NO live debug contract repairs, not a vacuous pass', async () => {
    const store = new SnapshotStore(new InMemoryBlobStore());
    // Round 1 playtest reports hasDebugContract=false (no window.__game.debug
    // snapshot wired) → must force a wire-debug repair, NOT credit a pass. Round 2
    // has the contract → passes.
    const noContract: PlaytestVerdict = { ...passingPlaytest(), hasDebugContract: false };
    const browserJobs = queuedBrowserJobs([noContract, passingPlaytest()]);
    let rounds = 0;
    const agent = specAgent(() => {
      rounds += 1;
    });
    const result = await runGeneration(
      {
        prompt: 'topdown',
        model: { provider: 'anthropic', modelId: 'claude-opus-4-8' },
        apiKey: 'sk-test',
      },
      { store, generate: agent, browserJobs },
    );
    expect(rounds).toBe(2); // the missing-contract round forced a repair
    expect(result.repairRounds).toBe(1);
    expect(result.shipReason).toBe('passed');
  });

  it('v3.1: a persistently staged skill is capped at ONE wiring round, then ships', async () => {
    const store = new SnapshotStore(new InMemoryBlobStore());
    const browserJobs = queuedBrowserJobs([
      passingPlaytest(),
      passingPlaytest(),
      passingPlaytest(),
    ]);
    const agent = wireAgent(null); // never wires
    const result = await runGeneration(
      {
        prompt: 'topdown',
        model: { provider: 'anthropic', modelId: 'claude-opus-4-8' },
        apiKey: 'sk-test',
      },
      { store, generate: agent.fn, browserJobs },
    );
    expect(agent.rounds()).toBe(2); // exactly one staged-unused round (one-shot cap)
    expect(result.repairRounds).toBe(1);
    expect(result.shipReason).toBe('passed');
  });

  it('v3.1: sweeps a provably-unreferenced staged module from the shipped artifact', async () => {
    const store = new SnapshotStore(new InMemoryBlobStore());
    const browserJobs = queuedBrowserJobs([passingPlaytest(), passingPlaytest()]);
    const agent = wireAgent(null); // imports src/engine/wave-spawner.js, NEVER wires it
    const result = await runGeneration(
      {
        prompt: 'topdown',
        model: { provider: 'anthropic', modelId: 'claude-opus-4-8' },
        apiKey: 'sk-test',
      },
      { store, generate: agent.fn, browserJobs },
    );
    // 3 files were written (index.html, src/engine/wave-spawner.js, src/main.js);
    // the dead, never-referenced wave-spawner is swept → 2 ship.
    expect(result.fileCount).toBe(2);
    await expect(
      store.readFile(result.snapshot.manifest, 'src/engine/wave-spawner.js'),
    ).rejects.toThrow();
  });

  it('v3 P9: a non-completable spec whose bundled playbook PASSES earns a real verdict (not skipped)', async () => {
    const store = new SnapshotStore(new InMemoryBlobStore());
    // Pre-v3 a non-completable spec (loseCondition —) took the skipped_non_completable
    // escape EVEN when its genre playbook scored — discarding a real verdict. v3 P9:
    // if the playbook actually scored (here, a clean pass), honour it. The topdown
    // playbook ran + passed, so this endless toy ships a genuine 'passed'.
    const browserJobs = queuedBrowserJobs([passingPlaytest()]);
    let rounds = 0;
    const agent: GenerateFn = async (_input, deps) => {
      rounds += 1;
      await deps.gameMode?.setSpec?.({
        ...TOPDOWN_SPEC,
        winCondition: '—',
        loseCondition: '—',
      } as unknown as GameSpec);
      await deps.fs?.create('index.html', RED_SQUARE);
      return emptyOutput('endless toy');
    };

    const result = await runGeneration(
      {
        prompt: 'endless topdown',
        model: { provider: 'anthropic', modelId: 'claude-opus-4-8' },
        apiKey: 'sk-test',
      },
      { store, generate: agent, browserJobs },
    );

    expect(result.repairRounds).toBe(0);
    expect(result.shipReason).toBe('passed');
    expect(rounds).toBe(1);
  });

  it('a no-predicate genre with no declared gameplay ships honest no_verdict — no fabricated interactivity pass (review M1/M2)', async () => {
    const store = new SnapshotStore(new InMemoryBlobStore());
    // 'tycoon' has no bundled playbook AND declares no gameplay caps. The floor must
    // NOT mint a 'passed' from generic-input/ambient drift (that was less honest than
    // no_verdict — adversarial review). With no caps it ships no_verdict without even
    // running a probe.
    const browserJobs = queuedBrowserJobs([invertedPlaytest()]);
    const agent: GenerateFn = async (_input, deps) => {
      await deps.gameMode?.setSpec?.({ ...TOPDOWN_SPEC, genre: 'tycoon' } as unknown as GameSpec);
      await deps.fs?.create('index.html', RED_SQUARE);
      return emptyOutput('idle');
    };

    const result = await runGeneration(
      {
        prompt: 'a tycoon',
        model: { provider: 'anthropic', modelId: 'claude-opus-4-8' },
        apiKey: 'sk-test',
      },
      { store, generate: agent, browserJobs },
    );

    expect(result.repairRounds).toBe(0);
    expect(result.shipReason).toBe('no_verdict'); // never a drift-driven vacuous pass
    expect(browserJobs.playtestCalls).toBe(0); // no declared gameplay → no probe needed
  });

  it('a no-predicate genre with NO debug snapshot still ships honest no_verdict (floor can read nothing) — plan step 5c', async () => {
    const store = new SnapshotStore(new InMemoryBlobStore());
    // Floor runs a probe but the game exposes no window.__game.debug snapshot →
    // hasDebugContract=false → the floor can't read state → honest no_verdict
    // (strictly no worse than the prior behavior; we didn't ask this genre to wire one).
    const browserJobs = queuedBrowserJobs([{ ...passingPlaytest(), hasDebugContract: false }]);
    const agent: GenerateFn = async (_input, deps) => {
      await deps.gameMode?.setSpec?.({ ...TOPDOWN_SPEC, genre: 'tycoon' } as unknown as GameSpec);
      await deps.fs?.create('index.html', RED_SQUARE);
      return emptyOutput('idle');
    };

    const result = await runGeneration(
      {
        prompt: 'a tycoon',
        model: { provider: 'anthropic', modelId: 'claude-opus-4-8' },
        apiKey: 'sk-test',
      },
      { store, generate: agent, browserJobs },
    );

    expect(result.repairRounds).toBe(0);
    expect(result.shipReason).toBe('no_verdict');
  });

  it('a no-predicate genre that DECLARES gameplay but wires no snapshot is REPAIRED (wire it), not no_verdict — plan step 7', async () => {
    const store = new SnapshotStore(new InMemoryBlobStore());
    // wantsVerdict (hasEnemies) + no snapshot across every round → the floor pushes
    // the wire-snapshot fatal each round → repairs to the ceiling rather than
    // shipping blind. Contrast the prior test (no declared gameplay → no_verdict).
    const noContract: PlaytestVerdict = { ...passingPlaytest(), hasDebugContract: false };
    const browserJobs = queuedBrowserJobs([noContract, noContract, noContract, noContract]);
    const agent: GenerateFn = async (_input, deps) => {
      await deps.gameMode?.setSpec?.({
        ...TOPDOWN_SPEC,
        genre: 'tycoon',
        capabilities: { hasEnemies: true },
      } as unknown as GameSpec);
      await deps.fs?.create('index.html', RED_SQUARE);
      return emptyOutput('idle');
    };

    const result = await runGeneration(
      {
        prompt: 'a tycoon with enemies',
        model: { provider: 'anthropic', modelId: 'claude-opus-4-8' },
        apiKey: 'sk-test',
      },
      { store, generate: agent, browserJobs },
    );

    expect(result.shipReason).not.toBe('no_verdict'); // it tried to repair (wire the snapshot)
    expect(result.repairRounds).toBeGreaterThan(0);
  });

  it('universal floor: a no-predicate genre that DECLARES gameplay + responds to input ships floor_verified (not blind no_verdict)', async () => {
    const store = new SnapshotStore(new InMemoryBlobStore());
    // wantsVerdict (hasEnemies) + wired snapshot + the floor probe shows input moving
    // a field BEYOND idle drift → the universal play floor passed. This is a real,
    // shallow verification — `floor_verified`, not the old blind `no_verdict`.
    const responsive: PlaytestVerdict = {
      hasGameContract: true,
      hasDebugContract: true,
      baselineSnapshot: { playerPos: { x: 0, y: 0 } },
      steps: [
        // step 0 = idle wait (no drift), then input frames move the player.
        {
          step: { kind: 'wait', frames: 24 },
          snapshotAfter: { playerPos: { x: 0, y: 0 } },
          errors: [],
        },
        {
          step: { kind: 'key', code: 'ArrowRight' },
          snapshotAfter: { playerPos: { x: 20, y: 0 } },
          errors: [],
        },
        {
          step: { kind: 'key', code: 'ArrowUp' },
          snapshotAfter: { playerPos: { x: 20, y: 20 } },
          errors: [],
        },
      ],
      bootErrors: [],
    };
    const browserJobs = queuedBrowserJobs([responsive]);
    const agent: GenerateFn = async (_input, deps) => {
      await deps.gameMode?.setSpec?.({
        ...TOPDOWN_SPEC,
        genre: 'tycoon',
        capabilities: { hasEnemies: true },
      } as unknown as GameSpec);
      await deps.fs?.create('index.html', RED_SQUARE);
      return emptyOutput('a responsive tycoon');
    };

    const result = await runGeneration(
      {
        prompt: 'a tycoon with enemies',
        model: { provider: 'anthropic', modelId: 'claude-opus-4-8' },
        apiKey: 'sk-test',
      },
      { store, generate: agent, browserJobs },
    );

    expect(result.repairRounds).toBe(0);
    expect(result.shipReason).toBe('floor_verified');
  });

  it('universal floor: a no-predicate game that IGNORES all input is REPAIRED (dead game), not no_verdict', async () => {
    const store = new SnapshotStore(new InMemoryBlobStore());
    // wantsVerdict + wired snapshot, but NOTHING moves under arrows/WASD/Space/click
    // across the probe → a dead / non-interactive game. The floor turns this into a
    // repairable fatal instead of shipping it blind.
    const dead: PlaytestVerdict = {
      hasGameContract: true,
      hasDebugContract: true,
      baselineSnapshot: { score: 0 },
      steps: [
        { step: { kind: 'wait', frames: 24 }, snapshotAfter: { score: 0 }, errors: [] },
        { step: { kind: 'key', code: 'ArrowRight' }, snapshotAfter: { score: 0 }, errors: [] },
        { step: { kind: 'key', code: 'Space' }, snapshotAfter: { score: 0 }, errors: [] },
      ],
      bootErrors: [],
    };
    const browserJobs = queuedBrowserJobs([dead]);
    const agent: GenerateFn = async (_input, deps) => {
      await deps.gameMode?.setSpec?.({
        ...TOPDOWN_SPEC,
        genre: 'tycoon',
        capabilities: { hasEnemies: true },
      } as unknown as GameSpec);
      await deps.fs?.create('index.html', RED_SQUARE);
      return emptyOutput('a dead tycoon');
    };

    const result = await runGeneration(
      {
        prompt: 'a tycoon with enemies',
        model: { provider: 'anthropic', modelId: 'claude-opus-4-8' },
        apiKey: 'sk-test',
      },
      { store, generate: agent, browserJobs },
    );

    expect(result.shipReason).not.toBe('no_verdict'); // not shipped blind
    expect(result.repairRounds).toBeGreaterThan(0); // the dead-game fatal drove repair
  });

  it('boot-gate: a non-booting game with no playbook still repairs (not a silent no_verdict)', async () => {
    const store = new SnapshotStore(new InMemoryBlobStore());
    let rounds = 0;
    const browserJobs: BrowserJobsPort & { playtestCalls: number } = {
      playtestCalls: 0,
      async runtimeVerify() {
        // Round 0 didn't boot; after one repair round it boots.
        return rounds <= 1
          ? {
              hasGameContract: false,
              fatalErrors: ['Uncaught ReferenceError: Phaser is not defined'],
            }
          : { hasGameContract: true, fatalErrors: [] };
      },
      async playtest() {
        this.playtestCalls += 1;
        return null;
      },
    };
    const agent: GenerateFn = async (_input, deps) => {
      rounds += 1;
      // 'idle' has no playbook — pre-fix this shipped a non-booting game as no_verdict.
      await deps.gameMode?.setSpec?.({ ...TOPDOWN_SPEC, genre: 'idle' } as unknown as GameSpec);
      await deps.fs?.create('index.html', RED_SQUARE);
      return emptyOutput('idle');
    };

    const result = await runGeneration(
      {
        prompt: 'an idle game',
        model: { provider: 'anthropic', modelId: 'claude-opus-4-8' },
        apiKey: 'sk-test',
      },
      { store, generate: agent, browserJobs },
    );

    // The boot failure forced at least one repair round rather than shipping blind.
    expect(result.repairRounds).toBeGreaterThanOrEqual(1);
  });

  it('inlines a MULTI-FILE game before the browser-worker boots it (no false boot failure on external src)', async () => {
    const store = new SnapshotStore(new InMemoryBlobStore());
    let verifyHtml = '';
    const browserJobs: BrowserJobsPort & { playtestCalls: number } = {
      playtestCalls: 0,
      async runtimeVerify(html) {
        verifyHtml = html;
        return { hasGameContract: true, fatalErrors: [] };
      },
      async playtest() {
        this.playtestCalls += 1;
        return null;
      },
    };
    const agent: GenerateFn = async (_input, deps) => {
      await deps.gameMode?.setEngine?.('phaser', 'multi-file game');
      await deps.gameMode?.setSpec?.({ ...TOPDOWN_SPEC, genre: 'idle' } as unknown as GameSpec);
      // The game references an EXTERNAL module the browser-worker can't fetch
      // from a bare index.html string — pre-fix this booted as "false".
      await deps.fs?.create(
        'index.html',
        '<!doctype html><html><head></head><body><canvas id="game"></canvas><script src="src/main.js"></script></body></html>',
      );
      await deps.fs?.create(
        'src/main.js',
        'window.__game = { debug: { snapshot: () => ({ score: 0 }) } };',
      );
      return emptyOutput('idle');
    };

    await runGeneration(
      {
        prompt: 'a multi-file game',
        model: { provider: 'anthropic', modelId: 'claude-opus-4-8' },
        apiKey: 'sk-test',
      },
      { store, generate: agent, browserJobs },
    );

    // The worker received a SELF-CONTAINED bundle — the external module is
    // inlined, not a dangling <script src="src/main.js"> it can't load.
    expect(verifyHtml.length).toBeGreaterThan(0);
    expect(verifyHtml).not.toContain('src="src/main.js"');
  });

  it('budget exhaustion (interrupted run) stops the loop early with budget_exhausted', async () => {
    const store = new SnapshotStore(new InMemoryBlobStore());
    const browserJobs = queuedBrowserJobs([invertedPlaytest()]);
    let rounds = 0;
    const agent: GenerateFn = async (_input, deps) => {
      rounds += 1;
      await deps.gameMode?.setSpec?.(TOPDOWN_SPEC);
      await deps.fs?.create('index.html', RED_SQUARE);
      // Agent gracefully checkpointed (wall-clock / output budget) — the
      // validation tail is spent, so a repair round can't run.
      return { ...emptyOutput('checkpointed'), interrupted: true };
    };

    const result = await runGeneration(
      {
        prompt: 'topdown',
        model: { provider: 'anthropic', modelId: 'claude-opus-4-8' },
        apiKey: 'sk-test',
      },
      { store, generate: agent, browserJobs },
    );

    expect(result.repairRounds).toBe(0);
    expect(result.shipReason).toBe('budget_exhausted');
    expect(rounds).toBe(1); // no repair round was attempted
  });

  it('without a browser-jobs port the loop is inert (no_verdict, 0 rounds)', async () => {
    const store = new SnapshotStore(new InMemoryBlobStore());
    const result = await runGeneration(
      {
        prompt: 'topdown',
        model: { provider: 'anthropic', modelId: 'claude-opus-4-8' },
        apiKey: 'sk-test',
      },
      { store, generate: specAgent() },
    );
    expect(result.repairRounds).toBe(0);
    expect(result.shipReason).toBe('no_verdict');
  });
});

describe('validateControlsManifest (controls-manifest lint)', () => {
  const f = (content: string) => [{ path: 'src/main.js', content }];

  it('flags MULTIPLE controls.define() with differing action sets (the shop-overwrite bug)', () => {
    // Mirrors the real regression: defineControls() (no shop) runs after a second
    // define() that had shop, wiping it from the manifest.
    const code = `
      function defineControls() {
        window.__game.controls.define({ actions: [
          { id: 'start', label: 'Start', keys: ['Space'] },
          { id: 'build', label: 'Build', keys: ['KeyB'] }
        ]});
      }
      class TitleScene { create() { defineControls(); } }
      window.__game.controls.define({ actions: [
        { id: 'build', label: 'Build', keys: ['KeyB'] },
        { id: 'shop',  label: 'Open Shop', keys: ['Tab', 'KeyE'] }
      ] });
      class PlayScene { update() { if (window.__game.controls.isDown('shop')) this.toggleShop(); } }
    `;
    const issues = validateControlsManifest(f(code));
    const dup = issues.find((i) => /RESETS the controls manifest/.test(i.message));
    expect(dup).toBeDefined();
    expect(dup?.severity).toBe('error');
  });

  it('flags a control read whose id is declared in NO define() (dangling binding)', () => {
    const code = `
      window.__game.controls.define({ actions: [{ id: 'jump', label: 'Jump', keys: ['Space'] }] });
      function tick() { if (window.__game.controls.isDown('dash')) doDash(); }
    `;
    const issues = validateControlsManifest(f(code));
    const dangling = issues.find((i) => i.message.includes("'dash'"));
    expect(dangling).toBeDefined();
    expect(dangling?.severity).toBe('error');
  });

  it('passes a clean single define() with all reads declared', () => {
    const code = `
      window.__game.controls.define({ actions: [
        { id: 'jump', label: 'Jump', keys: ['Space'] },
        { id: 'dash', label: 'Dash', keys: ['ShiftLeft'] }
      ] });
      if (window.__game.controls.isDown('jump')) jump();
      window.__game.controls.on('dash', dash);
    `;
    expect(validateControlsManifest(f(code))).toHaveLength(0);
  });

  it('ignores a game that does not use the controls API at all', () => {
    const code = `addEventListener('keydown', (e) => { if (e.code === 'Space') jump(); });`;
    expect(validateControlsManifest(f(code))).toHaveLength(0);
  });

  it('downgrades identical duplicate defines to a warn (harmless, not action-dropping)', () => {
    const code = `
      window.__game.controls.define({ actions: [{ id: 'jump', label: 'J', keys: ['Space'] }] });
      window.__game.controls.define({ actions: [{ id: 'jump', label: 'J', keys: ['Space'] }] });
    `;
    const issues = validateControlsManifest(f(code));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe('warn');
  });

  it('ENGINE_SCENE_VALIDATOR surfaces controls issues (ok=false) for every engine', () => {
    const code = `
      window.__game.controls.define({ actions: [{ id: 'a', keys: ['KeyA'] }] });
      window.__game.controls.define({ actions: [{ id: 'a', keys: ['KeyA'] }, { id: 'b', keys: ['KeyB'] }] });
      if (window.__game.controls.isDown('b')) {}
    `;
    const res = ENGINE_SCENE_VALIDATOR('canvas2d', [{ path: 'src/main.js', content: code }]);
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => /RESETS the controls manifest/.test(i.message))).toBe(true);
  });
});
