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
  type AttemptObservation,
  type DoneError,
  type GenerateInput,
  type GenerateOutput,
  type GenerateViaAgentDeps,
  type PlaytesterInput,
  type PlaytesterOutput,
  type PlaytestStep,
  type RepairVerdict,
  type RuntimeVerifyObservation as EvalRuntimeVerify,
  type ShipReason,
  buildRepairVerdict,
  decideRepairAction,
  generateViaAgent,
  resolveMaxRepairRounds,
  selectGamePlaytestPlan,
  traceFromPlaytestResult,
} from '@playforge/agent-core';
import type { ChatMessage } from '@playforge/shared';
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
  /**
   * #1.6 — repair-round budget for the bounded boot-and-repair loop. Defaults
   * to `DEFAULT_MAX_REPAIR_ROUNDS` (2), clamped to the hard ceiling (3) by
   * `resolveMaxRepairRounds`. Pass 0 to disable the repair loop entirely (the
   * run ships the first attempt's verdict regardless). The loop only ever
   * engages for completable game specs with a genre playbook that ships
   * machine-checkable predicates AND a live browser-jobs port — otherwise
   * there is no deterministic verdict to gate on and the run ships as-is.
   */
  maxRepairRounds?: number;
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
  /** #1.6 — number of bounded repair rounds the boot-and-repair loop ran
   *  before shipping. 0 when the first attempt passed (or the loop was
   *  inert: non-completable spec, no playbook predicates, or no browser-jobs
   *  port). Phase 5.6 telemetry + the dashboard read this. */
  repairRounds: number;
  /** #1.6 — why the run shipped the attempt it shipped (`passed` |
   *  `repair_exhausted` | `budget_exhausted` | `skipped_non_completable` |
   *  `no_verdict`). The deterministic verdict — never an LLM judgement —
   *  drives this. */
  shipReason: ShipReason;
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

  // #1.6 — run the agent once, then enter a BOUNDED boot-and-repair loop. Each
  // round re-invokes the agent with the prior transcript carried forward as
  // `history` plus a SPECIFIC repair instruction as the new user prompt; the
  // verdict that drives ship/no-ship is purely deterministic
  // (`scorePlaytest` + runtimeVerify fatalErrors), authored entirely below.
  // The LLM only ever ACTS on the repair text — it is never asked to judge
  // pass/fail. The actual playtest/boot stays out-of-process via `browserJobs`;
  // the gen worker never executes untrusted game code.
  const maxRepairRounds = resolveMaxRepairRounds(ports.maxRepairRounds);

  // Assemble a GenerateInput for a round: same model/key/budget/engine/signal
  // every time, only the user `prompt` and prior `history` change so a repair
  // round is a true continuation of the prior agent run.
  const buildInput = (prompt: string, history: ChatMessage[]): GenerateInput => ({
    prompt,
    model: req.model,
    apiKey: req.apiKey,
    history,
    artifactType: 'game',
    agentBudget: { maxToolCalls, maxWallClockMs },
    ...(req.engine ? { engine: req.engine } : {}),
    ...(tokenAbortController ? { signal: tokenAbortController.signal } : {}),
  });

  // Build the deterministic verdict for the CURRENT working tree by round-
  // tripping the genre playbook's synthetic-input plan through the browser-
  // jobs queue (out-of-process) and scoring the trace with `scorePlaytest`.
  // Returns null when no deterministic verdict is obtainable (no port, no
  // game artifact, no spec, or no playbook predicates for the genre) — the
  // loop then ships the attempt as-is.
  const observeVerdict = async (): Promise<RepairVerdict | null> => {
    if (browserJobs === undefined) return null;
    const spec = state.spec;
    if (spec === null) return null;
    const plan = selectGamePlaytestPlan(spec.genre);
    if (plan === null || plan.predicates.length === 0) return null;
    const entry = tree.view('index.html');
    if (entry === null) return null;

    const playVerdict = await browserJobs.playtest(entry.content, plan.steps);
    const rvVerdict = await browserJobs.runtimeVerify(entry.content);
    if (rvVerdict !== null) {
      // Keep the eval observation current with this attempt's boot result so
      // the captured recording reflects the SHIPPED artifact, not a stale
      // earlier round.
      lastRuntimeVerify = {
        booted: rvVerdict.hasGameContract,
        fatalErrors: [...rvVerdict.fatalErrors],
      };
    }
    const fatalErrors: string[] = rvVerdict === null ? [] : [...rvVerdict.fatalErrors];
    if (rvVerdict !== null && !rvVerdict.hasGameContract) {
      fatalErrors.push(
        'Runtime load: window.__game never appeared — the game did not boot.',
      );
    }
    const observation: AttemptObservation = {
      trace: playVerdict === null ? null : traceFromPlaytestResult(playVerdict),
      fatalErrors,
    };
    return buildRepairVerdict(observation, plan.predicates);
  };

  // Round 0 + repair rounds. `history` carries the prior transcript forward so
  // each repair round is a true continuation (the agent sees its own prior
  // work + the concrete failure), not a cold restart.
  const history: ChatMessage[] = [];
  let nextPrompt = req.prompt;
  let output: GenerateOutput = await generate(buildInput(nextPrompt, history), deps);
  let repairRounds = 0;
  let shipReason: ShipReason = 'no_verdict';

  for (;;) {
    const verdict = await observeVerdict();
    if (verdict === null) {
      // No deterministic verdict (no port / no spec / no predicates / no
      // artifact). Nothing to gate on — ship as-is.
      shipReason = 'no_verdict';
      break;
    }
    // Budget exhaustion: the validation-tail token ceiling (1.2) tripped
    // mid-run (`aborted`) OR the agent gracefully checkpointed
    // (`output.interrupted`). Either way a further repair round can't run to
    // completion, so we stop and ship the best attempt.
    const budgetExhausted = aborted || output.interrupted;
    const action = decideRepairAction(verdict, state.spec, {
      roundsRun: repairRounds,
      maxRounds: maxRepairRounds,
      budgetExhausted,
    });
    if (action.kind === 'ship') {
      shipReason = action.reason;
      break;
    }
    // Re-invoke the agent with the prior transcript + the specific repair
    // instruction. Carry the agent's prior assistant message into history so
    // the continuation threads correctly.
    history.push(
      { role: 'user', content: nextPrompt },
      { role: 'assistant', content: output.message },
    );
    nextPrompt = action.instruction;
    repairRounds += 1;
    output = await generate(buildInput(nextPrompt, history), deps);
  }

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
    repairRounds,
    shipReason,
    ...(lastRuntimeVerify !== undefined ? { runtimeVerify: lastRuntimeVerify } : {}),
  };
}
