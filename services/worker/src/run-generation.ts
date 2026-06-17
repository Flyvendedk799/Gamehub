/**
 * runGeneration — the worker's orchestration of a single agentic game build.
 *
 * It wires the cloud implementations of the agent's host dependencies and runs
 * the agent to completion, then serializes the resulting file tree to the
 * content-addressed snapshot store:
 *   - fs        → WorkingTree (in-memory bundle, traversal-guarded)
 *   - onEvent   → caller's sink (production: Redis pub/sub → SSE)
 *   - gameMode  → in-run engine + spec carry-forward (setEngine/getCurrentEngine
 *                 /setSpec/getSpec) + scene validation
 *
 * The agent runner is INJECTABLE (`ports.generate`, default the real
 * `generateViaAgent`) so the full orchestration is testable offline without a
 * provider key — production passes nothing and gets the real agent.
 */
import {
  type AgentEvent,
  type DoneError,
  type GenerateInput,
  type GenerateOutput,
  type GenerateViaAgentDeps,
  type PlaytesterInput,
  type PlaytesterOutput,
  type PlaytestStep,
  type RuntimeVerifyObservation as EvalRuntimeVerify,
  generateViaAgent,
} from '@playforge/agent-core';
// Import from the engines subpath, NOT the package root — the root re-exports the
// desktop React/Babel design-canvas vendor (?raw) which has no business in the
// game-gen worker and won't resolve under its tsconfig.
import { GAME_ENGINE_ADAPTERS } from '@playforge/runtime/engines';
import { makeAssetGenerator } from './asset-generator';
import type { GameSpec, ModelRef } from '@playforge/shared';
import type { SnapshotStore, WriteResult } from '@playforge/storage';
import { WorkingTree } from './working-tree';

export type WebEngine = 'three' | 'phaser';
export type GenerateFn = (
  input: GenerateInput,
  deps: GenerateViaAgentDeps,
) => Promise<GenerateOutput>;

/** A single scene-validation finding (mirrors the runtime adapter's shape). */
export interface SceneIssue {
  path: string;
  line?: number | undefined;
  message: string;
  severity: 'error' | 'warn';
}

/** Engine scene validator (host delegates to the @playforge/runtime adapter). */
export type SceneValidator = (
  engine: 'three' | 'phaser',
  files: ReadonlyArray<{ path: string; content: string }>,
) => { ok: boolean; engine: 'three' | 'phaser'; issues: SceneIssue[] };

export interface GenerationRequest {
  prompt: string;
  model: ModelRef;
  apiKey: string;
  /** Optional pre-pick; when omitted the agent calls choose_engine itself. */
  engine?: WebEngine;
  /** Seed the working tree (e.g. a remix's parent snapshot). */
  initialFiles?: Iterable<readonly [string, string]>;
  /** Provider name (e.g. 'openai') — used to enable image asset generation. */
  provider?: string;
}

/**
 * Out-of-process browser-jobs port (#1.4). The worker NEVER boots untrusted
 * game code in-process; instead it round-trips runtime-verify + playtest
 * requests through this port to the dedicated browser-worker pool over the
 * `browser-jobs` BullMQ queue. The concrete implementation
 * (`BrowserJobsClient` in browser-jobs.ts) is constructed by the worker's
 * main.ts against the shared REDIS_URL; offline tests inject a stub or omit it
 * entirely (falling back to the current no-runtimeVerify / no-playtester
 * behaviour). Returning `null` means "no verdict available" (queue down /
 * timed out) — the caller degrades gracefully and treats it as no evidence,
 * never as a hard failure.
 */
export interface BrowserJobsPort {
  /** Boot the artifact, return whether window.__game appeared + any fatal
   *  console errors. `null` when no verdict could be obtained. */
  runtimeVerify(htmlContent: string): Promise<RuntimeVerifyVerdict | null>;
  /** Boot the artifact, drive the synthetic-input plan, return the snapshot
   *  trace. `null` when no verdict could be obtained. */
  playtest(htmlContent: string, steps: ReadonlyArray<PlaytestStep>): Promise<PlaytestVerdict | null>;
}

/** Minimal runtime-verify verdict the worker consumes from the browser-jobs
 *  round-trip (a subset of the browser-worker RuntimeVerifyResult). */
export interface RuntimeVerifyVerdict {
  hasGameContract: boolean;
  fatalErrors: string[];
}

/** Playtest verdict the worker consumes — maps onto the agent PlaytesterOutput. */
export interface PlaytestVerdict {
  hasGameContract: boolean;
  hasDebugContract: boolean;
  baselineSnapshot: unknown;
  steps: ReadonlyArray<{ step: PlaytestStep; snapshotAfter: unknown; errors: ReadonlyArray<string> }>;
  bootErrors: ReadonlyArray<string>;
}

export interface GenerationPorts {
  store: SnapshotStore;
  onEvent?: (event: AgentEvent) => void;
  /** Injectable agent runner. Defaults to the real generateViaAgent. */
  generate?: GenerateFn;
  /** Engine scene validator. Defaults to a permissive pass. */
  validateScene?: SceneValidator;
  /** Hard ceiling on total tokens (input + output) for this run. Aborts cleanly when exceeded. */
  maxTokens?: number;
  /**
   * Out-of-process browser-jobs port. When supplied, the agent's `done`
   * runtime-verify and `playtest_game` tool become live (round-tripping to the
   * browser-worker pool). When omitted (offline tests / no-Redis dev), the run
   * falls back to static-lint-only `done` with no `playtest_game` registered.
   */
  browserJobs?: BrowserJobsPort;
}

export interface GenerationResult {
  output: GenerateOutput;
  engine: WebEngine | null;
  spec: GameSpec | null;
  snapshot: WriteResult;
  fileCount: number;
  /** File listing at run end — used to build continuation fsState. */
  fsState: Array<{ path: string; bytes: number }>;
  /** Phase 5.3 — last runtime-verify verdict (window.__game present +
   *  fatal boot errors), when a browser-jobs port produced one. The eval
   *  capture pipeline writes this into an `evals/recordings/<slug>.json`
   *  `observation.runtimeVerify` so the eval scores the OUTPUT, not just
   *  the process. `undefined` when no verdict was obtained (no port /
   *  queue down). */
  runtimeVerify?: EvalRuntimeVerify;
}

/**
 * Real engine scene validator (#1.1): dispatches to the @playforge/runtime
 * adapter for the current engine and maps its ValidationResult to the host
 * SceneValidator shape. Replaces the old PASS_VALIDATOR no-op so the agent's
 * MANDATORY `validate_game_scene` gate runs a genuine engine lint (e.g. a
 * Phaser `this.add.image('hero')` with no prior `load.image('hero')`, or a
 * Three.js unreachable-trigger) instead of always returning ok:true. Before
 * this, the cloud worker handed the agent a permissive pass, so the headline
 * "win/lose-validated, anti-slop" guarantee ran on nothing server-side.
 */
export const ENGINE_SCENE_VALIDATOR: SceneValidator = (engine, files) => {
  const adapter = GAME_ENGINE_ADAPTERS.get(engine);
  if (!adapter) return { ok: true, engine, issues: [] };
  const result = adapter.validate(files);
  if (result.ok) return { ok: true, engine, issues: [] };
  // ValidationIssue and the host SceneIssue are the same shape ({path,line?,
  // message,severity}) — pass through.
  return { ok: false, engine, issues: result.issues };
};

export async function runGeneration(
  req: GenerationRequest,
  ports: GenerationPorts,
): Promise<GenerationResult> {
  const generate = ports.generate ?? generateViaAgent;
  const validateScene = ports.validateScene ?? ENGINE_SCENE_VALIDATOR;
  const tree = new WorkingTree(req.initialFiles);

  // Hard run ceiling (#18) — abort cleanly when a token budget is set.
  // The agent emits a `turn_end` AgentEvent after each model turn carrying the
  // assistant message's cumulative `usage` (input/output/totalTokens). We watch
  // those in wrappedOnEvent below and call tokenAbortController.abort() the first
  // time (input + output) crosses ports.maxTokens, so the agent stops cleanly via
  // its abort signal instead of running to the budget's edge unobserved.
  //
  // maxToolCalls / maxWallClockMs remain as belt-and-suspenders proxies in case a
  // provider streams without usage on turn_end: we still derive a tool-call cap
  // from the token budget and keep a 20-minute wall.
  let tokenAbortController: AbortController | undefined;
  let aborted = false;
  if (ports.maxTokens !== undefined) {
    tokenAbortController = new AbortController();
  }
  // #1.2 — game runs need enough tool headroom to actually REACH the mandatory
  // validate → playtest → done tail; a stingy floor aborts a build before it can
  // validate, shipping an unvalidated game. (The token CEILING above is the real
  // cost guard; this is just the soft tool-call cap's floor.)
  const maxToolCalls = ports.maxTokens !== undefined
    ? Math.max(40, Math.floor(ports.maxTokens / 3000))
    : 120;
  const maxWallClockMs = 20 * 60 * 1000; // 20 minutes hard wall

  // In-run mutable state the agent reads/writes via the gameMode callbacks and
  // that we persist alongside the snapshot once the run completes.
  const state: { engine: WebEngine | null; spec: GameSpec | null } = {
    engine: req.engine ?? null,
    spec: null,
  };

  // Wrap the caller's event sink so we can meter token usage from `turn_end`
  // events and trip the abort signal once the budget is exceeded. When no token
  // ceiling is set, this is a transparent pass-through.
  const wrappedOnEvent: ((event: AgentEvent) => void) | undefined =
    ports.onEvent === undefined && tokenAbortController === undefined
      ? undefined
      : (event: AgentEvent) => {
          if (tokenAbortController && !aborted && event.type === 'turn_end') {
            const usage = (event.message as { usage?: { input?: number; output?: number } }).usage;
            if (usage) {
              const used = (usage.input ?? 0) + (usage.output ?? 0);
              if (used > ports.maxTokens!) {
                aborted = true;
                tokenAbortController.abort();
              }
            }
          }
          ports.onEvent?.(event);
        };

  const generateImageAsset = makeAssetGenerator({
    apiKey: req.apiKey,
    provider: req.provider ?? 'openai',
  });

  // #1.4 — wire the out-of-process browser-jobs port into the agent's runtime
  // gates. Both adapters round-trip to the dedicated browser-worker pool; the
  // gen worker itself never boots untrusted game code.
  const browserJobs = ports.browserJobs;

  // `done`'s runtime-load gate: boot the artifact in the browser-worker, return
  // any fatal console errors so `done` reports status='has_errors' (instead of
  // force-accepting on static lint alone). A `null` verdict (queue down) yields
  // no errors so the run is not blocked by missing verification infra.
  //
  // Phase 5.3 — eval output-quality hook: we ALSO retain the last verdict so
  // the run can surface it as an eval `RuntimeVerifyObservation` (booted +
  // fatalErrors). This is the production source for a recording's
  // `observation.runtimeVerify` field; a capture pipeline reads
  // `GenerationResult.runtimeVerify` and writes it into evals/recordings.
  let lastRuntimeVerify: EvalRuntimeVerify | undefined;
  const runtimeVerify: GenerateViaAgentDeps['runtimeVerify'] | undefined =
    browserJobs === undefined
      ? undefined
      : async (artifactSource: string): Promise<DoneError[]> => {
          const verdict = await browserJobs.runtimeVerify(artifactSource);
          if (verdict === null) return [];
          lastRuntimeVerify = {
            booted: verdict.hasGameContract,
            fatalErrors: [...verdict.fatalErrors],
          };
          const errors: DoneError[] = verdict.fatalErrors.map((message) => ({
            message,
            source: 'runtime',
          }));
          if (!verdict.hasGameContract) {
            errors.push({
              message:
                'Runtime load: window.__game never appeared — the game did not boot. ' +
                'Ensure the engine bootstrap runs and assigns window.__game before done.',
              source: 'runtime',
            });
          }
          return errors;
        };

  // `playtest_game`'s host playtester: drive the agent's synthetic-input plan
  // in the browser-worker and map the trace back to the agent PlaytesterOutput.
  const playtester: NonNullable<NonNullable<GenerateViaAgentDeps['gameMode']>['playtester']> | undefined =
    browserJobs === undefined
      ? undefined
      : async (pInput: PlaytesterInput): Promise<PlaytesterOutput> => {
          const verdict = await browserJobs.playtest(pInput.artifactSource, pInput.steps);
          if (verdict === null) {
            return {
              hasDebugContract: false,
              baselineSnapshot: null,
              steps: [],
              bootErrors: [
                'playtest infrastructure unavailable — the browser-worker did not return a verdict.',
              ],
            };
          }
          return {
            hasDebugContract: verdict.hasDebugContract,
            baselineSnapshot: verdict.baselineSnapshot,
            steps: verdict.steps.map((s) => ({
              step: s.step,
              snapshotAfter: s.snapshotAfter,
              errors: s.errors,
            })),
            bootErrors: verdict.bootErrors,
          };
        };

  const deps: GenerateViaAgentDeps = {
    fs: tree,
    generateImageAsset,
    ...(wrappedOnEvent !== undefined ? { onEvent: wrappedOnEvent } : {}),
    ...(runtimeVerify !== undefined ? { runtimeVerify } : {}),
    gameMode: {
      setEngine: (engine) => {
        if (engine === 'three' || engine === 'phaser') state.engine = engine;
      },
      getCurrentEngine: () => state.engine,
      validate: (engine, files) =>
        engine === 'three' || engine === 'phaser'
          ? validateScene(engine, files)
          : { ok: true, engine: 'phaser', issues: [] },
      setSpec: (spec) => {
        state.spec = spec;
      },
      getSpec: () => state.spec ?? undefined,
      ...(playtester !== undefined ? { playtester } : {}),
    },
  };

  const input: GenerateInput = {
    prompt: req.prompt,
    model: req.model,
    apiKey: req.apiKey,
    history: [],
    artifactType: 'game',
    agentBudget: { maxToolCalls, maxWallClockMs },
    ...(req.engine ? { engine: req.engine } : {}),
    ...(tokenAbortController ? { signal: tokenAbortController.signal } : {}),
  };

  const output = await generate(input, deps);
  const snapshot = await tree.persist(ports.store);

  const encoder = new TextEncoder();
  const fsState = tree.toSnapshotInput().map((f) => ({
    path: f.path,
    bytes: f.bytes instanceof Uint8Array ? f.bytes.length : encoder.encode(f.bytes as string).length,
  }));

  return {
    output,
    engine: state.engine,
    spec: state.spec,
    snapshot,
    fileCount: tree.size,
    fsState,
    ...(lastRuntimeVerify !== undefined ? { runtimeVerify: lastRuntimeVerify } : {}),
  };
}
