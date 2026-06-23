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
  type RuntimeVerifyObservation as EvalRuntimeVerify,
  type GamePlaytestPlan,
  type GenerateInput,
  type GenerateOutput,
  type GenerateViaAgentDeps,
  PREMIUM_STARTERS,
  PREMIUM_STARTER_PATH,
  type PlaytestStep,
  type PlaytesterInput,
  type PlaytesterOutput,
  type RepairVerdict,
  type ShipReason,
  buildInteractivityFloorPlan,
  buildRepairVerdict,
  decideRepairAction,
  generateViaAgent,
  recommendSkills,
  resolveMaxRepairRounds,
  selectGamePlaytestPlan,
  traceFromPlaytestResult,
} from '@playforge/agent-core';
// Import from the engines subpath, NOT the package root — the root pulls in
// browser/Vite-only vendor assets (?raw) that have no business in the
// game-gen worker and won't resolve under its tsconfig.
import { GAME_ENGINE_ADAPTERS } from '@playforge/runtime/engines';
import { computeImpliedCost, normalizeEngineCdnUrls } from '@playforge/shared';
import type { ChatMessage } from '@playforge/shared';
import type { GameSpec, ModelRef } from '@playforge/shared';
import type { SnapshotStore, WriteResult } from '@playforge/storage';
// Relative import into the exporters package src (same pattern the API uses for
// the worker) — reuses the proven single-file game bundler for the verify gate.
import { buildGameHtml } from '../../../packages/exporters/src/index';
import { makeAssetGenerator } from './asset-generator';
import { createRunSignalAggregator } from './run-signal';
import { analyzeSkillUsage } from './skill-usage-grep.js';
import { assertGeneratedJavaScriptSyntax } from './syntax-check';
import { WorkingTree } from './working-tree';

export type WebEngine = 'three' | 'phaser' | 'canvas2d';
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
  engine: WebEngine,
  files: ReadonlyArray<{ path: string; content: string }>,
) => { ok: boolean; engine: WebEngine; issues: SceneIssue[] };

export interface GenerationRequest {
  prompt: string;
  model: ModelRef;
  apiKey: string;
  /** Wire-format override (e.g. 'openai-codex-responses' for a Codex subscription). */
  wire?: import('@playforge/shared').WireApi;
  /** Extra HTTP headers for the model call (e.g. chatgpt-account-id for Codex). */
  httpHeaders?: Record<string, string>;
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
  playtest(
    htmlContent: string,
    steps: ReadonlyArray<PlaytestStep>,
  ): Promise<PlaytestVerdict | null>;
}

/** Minimal runtime-verify verdict the worker consumes from the browser-jobs
 *  round-trip (a subset of the browser-worker RuntimeVerifyResult). */
export interface RuntimeVerifyVerdict {
  hasGameContract: boolean;
  fatalErrors: string[];
  /**
   * Phase 5.5 — deterministic juice/density score the browser-worker measured
   * for the booted artifact (forced-frame canvas pixel-delta + animation
   * churn). ADDITIVE + OPTIONAL: Phase 1.6's `buildRepairVerdict` only reads
   * `fatalErrors`, so it is unaffected. `undefined` when the verdict predates
   * juice measurement (e.g. a queue node that has not yet been updated to
   * forward it). When present, it is surfaced into the eval observation +
   * persisted in the per-run quality telemetry row.
   */
  juiceScore?: number;
}

/**
 * Phase 5.6 — per-run quality telemetry record. Assembled from the data already
 * in hand after the boot-and-repair loop settles and handed to the injectable
 * `recordRunQuality` port for a best-effort persist into `run_quality_metrics`.
 * Mirrors the table columns. `forceAccept` is derived (ship without a passing
 * deterministic verdict). All fields are deterministic — never an LLM judgement.
 */
export interface RunQualityMetrics {
  genre: string | null;
  /** True when the run shipped WITHOUT a passing deterministic verdict. */
  forceAccept: boolean;
  repairRounds: number;
  shipReason: ShipReason;
  /** Genre-playbook predicate pass-count for the shipped attempt. */
  playbookPass: number;
  /** Total genre-playbook predicates evaluated for the shipped attempt. */
  playbookTotal: number;
  /** Measured juice/density score (5.5), or null when not measured. */
  juiceScore: number | null;
  /** Whether window.__game appeared on boot (5.3), or null when not measured. */
  runtimeBooted: boolean | null;
  /** Full structured per-run build report (spec shape + tool/skill histogram +
   *  invariant warnings + novelty path + tokens) persisted as JSON for analysis.
   *  Optional so existing callers/tests that build a metrics literal still type. */
  report?: Record<string, unknown>;
}

/**
 * Best-effort sink for the per-run quality telemetry row (5.6). The worker's
 * main.ts injects a concrete implementation that writes `run_quality_metrics`
 * keyed on the runId; offline tests inject a recorder/no-op. The implementation
 * MUST be non-fatal — a telemetry write failure must never fail a generation —
 * but runGeneration ALSO wraps the call so a throwing port cannot break a run.
 */
export type RecordRunQualityFn = (metrics: RunQualityMetrics) => void | Promise<void>;

/** Playtest verdict the worker consumes — maps onto the agent PlaytesterOutput. */
export interface PlaytestVerdict {
  hasGameContract: boolean;
  hasDebugContract: boolean;
  baselineSnapshot: unknown;
  steps: ReadonlyArray<{
    step: PlaytestStep;
    snapshotAfter: unknown;
    errors: ReadonlyArray<string>;
  }>;
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
  /**
   * #5.6 — best-effort per-run quality telemetry sink. When supplied, ONE
   * `run_quality_metrics` row is assembled from the data already in hand
   * (shipReason, repairRounds, playbook pass/total, juiceScore, runtimeBooted,
   * force_accept) and handed to this sink after the loop settles. The call is
   * wrapped + logged so a telemetry failure can NEVER fail a generation. Omitted
   * in offline dev / tests that don't assert telemetry.
   */
  recordRunQuality?: RecordRunQualityFn;
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
  /** Run-total token usage, summed from every `turn_end`. Persisted to the
   *  `runs` row for cost attribution. Zero when the provider streams no usage. */
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    /** Prompt-cache reads (the static prefix served from cache) + writes. */
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
  /** WS-D — set when the run paused because the agent called `ask_user`. The
   *  caller persists it on the continuation_pending row so the builder can show
   *  the question + collect an answer. Null for a normal/complete run. */
  pendingQuestion?: string | null;
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
/**
 * True for verify-only asset/XHR-load failures introduced by inlining a
 * multi-file game for the boot gate (relative asset paths can't resolve under
 * setContent). These are harness artifacts, not game bugs — the real preview
 * serves those files — so they must not count toward the runtime-verify verdict.
 */
export function isVerifyInlineAssetNoise(message: string): boolean {
  return /Failed to execute 'open' on 'XMLHttpRequest'|XMLHttpRequest.*Invalid URL|Invalid URL.*XMLHttpRequest|Failed to load resource/i.test(
    message,
  );
}

export const ENGINE_SCENE_VALIDATOR: SceneValidator = (engine, files) => {
  const adapter = GAME_ENGINE_ADAPTERS.get(engine);
  if (!adapter) return { ok: true, engine, issues: [] };
  const result = adapter.validate(files);
  if (result.ok) return { ok: true, engine, issues: [] };
  // ValidationIssue and the host SceneIssue are the same shape ({path,line?,
  // message,severity}) — pass through.
  return { ok: false, engine, issues: result.issues };
};

/** v3.1 — the repair instruction for staged-unused skills (imported to
 *  src/engine/ but never imported + called). Tells the agent to wire OR delete
 *  each, so the import→use gap is closed deterministically before shipping. */
function buildStagedUnusedInstruction(staged: string[]): string {
  const list = staged.join(', ');
  const lines = staged
    .map(
      (b) =>
        `  - ${b}: \`import { ... } from './engine/${b}.js'\` in src/main.js and CALL its exports`,
    )
    .join('\n');
  return [
    `SKILL WIRING REPAIR — you imported these vetted modules but never CALL them: ${list}.`,
    'The import line is already in your entry — CALLING the skill IS how you implement that system, so do NOT keep a hand-rolled parallel version. For EACH module, do ONE of:',
    lines,
    '  ...OR, only if you genuinely do not need it, delete src/engine/<name>.js AND its import line.',
    'Then re-run validate_game_scene + playtest_game and call done. Change nothing unrelated.',
  ].join('\n');
}

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
  const maxToolCalls =
    ports.maxTokens !== undefined ? Math.max(40, Math.floor(ports.maxTokens / 3000)) : 120;
  const maxWallClockMs = 20 * 60 * 1000; // 20 minutes hard wall

  // In-run mutable state the agent reads/writes via the gameMode callbacks and
  // that we persist alongside the snapshot once the run completes.
  const state: {
    engine: WebEngine | null;
    spec: GameSpec | null;
    // Agent-authored playtest contract — the deterministic verdict source for a
    // genre-less game (set via declare_playtest_contract; null otherwise).
    contract: GamePlaytestPlan | null;
  } = {
    engine: req.engine ?? null,
    spec: null,
    contract: null,
  };

  // Wrap the caller's event sink so we can meter token usage from `turn_end`
  // events and trip the abort signal once the budget is exceeded. When no token
  // ceiling is set, this is a transparent pass-through.
  //
  // Each `turn_end` carries that ONE turn's usage (the codebase's own
  // `aggregateRunUsage` sums per-turn usage to get a run total — proof the value
  // is per-turn, not cumulative). So we accumulate across turns and compare the
  // RUN total to the ceiling; comparing a single turn against the whole-run
  // budget let a many-turn run spend a large multiple of the ceiling unchecked. (H1)
  // Run-total token usage, metered from every `turn_end` (each carries that
  // turn's input/output). We accumulate UNCONDITIONALLY (not only when a token
  // ceiling is set) so the completed run row records real token counts for cost
  // attribution + the build-health dashboard — previously runs always persisted
  // 0/0 because metering was gated behind maxTokens.
  let usedInputTokens = 0;
  let usedOutputTokens = 0;
  // Prompt-cache visibility — cacheRead = the big static prefix served from
  // cache (the win), cacheWrite = priming it. A high read/input ratio means
  // caching is working; logged at completion so it's monitorable.
  let usedCacheReadTokens = 0;
  let usedCacheWriteTokens = 0;
  const meterUsage = (event: AgentEvent): void => {
    if (event.type !== 'turn_end') return;
    const usage = (
      event.message as {
        usage?: {
          input?: number;
          output?: number;
          cacheRead?: number;
          cacheWrite?: number;
        };
      }
    ).usage;
    if (!usage) return;
    usedInputTokens += usage.input ?? 0;
    usedOutputTokens += usage.output ?? 0;
    usedCacheReadTokens += usage.cacheRead ?? 0;
    usedCacheWriteTokens += usage.cacheWrite ?? 0;
    if (tokenAbortController && !aborted && usedInputTokens + usedOutputTokens > ports.maxTokens!) {
      aborted = true;
      tokenAbortController.abort();
    }
  };
  // Distils the agent's tool/skill/invariant/contract signal from the live event
  // stream so each run emits a structured [build-report] we can learn from.
  const signal = createRunSignalAggregator();
  const wrappedOnEvent: (event: AgentEvent) => void = (event: AgentEvent) => {
    meterUsage(event);
    signal.observe(event);
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

  // WS-C — the agent's runtime-verify + playtest gates boot the artifact in the
  // browser-worker via setContent(html), which only has the ENTRY file. A
  // multi-file game (index.html + src/main.js + assets) therefore can't load its
  // modules/assets → window.__game never appears → a FALSE "did not boot",
  // so the boot-and-repair loop couldn't catch (or fix) incomplete games. Inline
  // the whole project into one self-contained HTML first (the same proven
  // single-file bundler the publish path uses — engine + modules + assets all
  // inlined, no network), so the gate boots the REAL game. Falls back to the raw
  // entry if inlining isn't possible (no engine chosen / no index.html / error).
  const inlineForVerify = async (fallbackHtml: string): Promise<string> => {
    const engine = state.engine;
    if (engine !== 'three' && engine !== 'phaser') return fallbackHtml;
    try {
      const files = tree.toSnapshotInput().map((f) => ({
        path: f.path,
        content: Buffer.from(f.bytes),
      }));
      if (!files.some((f) => f.path === 'index.html')) return fallbackHtml;
      return await buildGameHtml({ files, engine });
    } catch (err) {
      console.warn(`[run-generation] verify inline failed, using raw entry: ${String(err)}`);
      return fallbackHtml;
    }
  };

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
          const verdict = await browserJobs.runtimeVerify(await inlineForVerify(artifactSource));
          if (verdict === null) return [];
          // Inlining a multi-file game leaves JS-loaded asset paths relative, so
          // they 404/XHR-fail under setContent — a verify-harness artifact, NOT a
          // game bug (the real preview serves those assets fine). Drop that noise
          // so it doesn't read as fatal and trigger a phantom repair round.
          const fatalErrors = verdict.fatalErrors.filter((e) => !isVerifyInlineAssetNoise(e));
          lastRuntimeVerify = {
            booted: verdict.hasGameContract,
            fatalErrors,
            ...(verdict.juiceScore !== undefined ? { juiceScore: verdict.juiceScore } : {}),
          };
          const errors: DoneError[] = fatalErrors.map((message) => ({
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
  const playtester:
    | NonNullable<NonNullable<GenerateViaAgentDeps['gameMode']>['playtester']>
    | undefined =
    browserJobs === undefined
      ? undefined
      : async (pInput: PlaytesterInput): Promise<PlaytesterOutput> => {
          const html = await inlineForVerify(pInput.artifactSource);
          const verdict = await browserJobs.playtest(html, pInput.steps);
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
              errors: s.errors.filter((e) => !isVerifyInlineAssetNoise(e)),
            })),
            bootErrors: verdict.bootErrors.filter((e) => !isVerifyInlineAssetNoise(e)),
          };
        };

  // WS-D — when the agent calls ask_user, record the question; buildInput's
  // getContinuationHint then pauses the run cleanly at the next safe boundary
  // (output.interrupted=true), and the caller (queue.ts → finalizeRun) persists
  // the question on the continuation_pending row so the builder can collect an
  // answer and resume.
  let pendingQuestion: string | null = null;

  const deps: GenerateViaAgentDeps = {
    fs: tree,
    generateImageAsset,
    onEvent: wrappedOnEvent,
    onAskUser: (question) => {
      pendingQuestion = question;
    },
    ...(runtimeVerify !== undefined ? { runtimeVerify } : {}),
    gameMode: {
      setEngine: (engine) => {
        // Accept every supported engine incl. canvas2d (v2 P8) — the old guard
        // silently dropped canvas2d, persisting engine: null.
        if (engine === 'three' || engine === 'phaser' || engine === 'canvas2d') {
          state.engine = engine;
          // Premium pivot: SEED a complete, bootable, premium starter at src/main.js
          // the moment the engine is pinned, so the agent EDITS a premium scaffold
          // (art direction + screens + juice/sfx + draw-the-subject + preserveDrawing-
          // Buffer) instead of writing a bare loop from scratch — guide-level premium
          // only got partial adoption (confirm 2026-06-23). Seed ONLY when nothing is
          // there yet: a remix (initialFiles) or an agent who already wrote an entry
          // keeps their file. The choose_engine result tells the agent to adapt it.
          if (tree.view(PREMIUM_STARTER_PATH) === null) {
            tree.create(PREMIUM_STARTER_PATH, PREMIUM_STARTERS[engine]);
          }
        }
      },
      getCurrentEngine: () => state.engine,
      // Route through the real validator (ENGINE_SCENE_VALIDATOR handles canvas2d
      // too) so a canvas2d game runs its own scene lint instead of being skipped
      // and mislabeled as phaser.
      validate: (engine, files) => validateScene(engine, files),
      setSpec: (spec) => {
        state.spec = spec;
      },
      getSpec: () => state.spec ?? undefined,
      setContract: (plan) => {
        state.contract = plan;
      },
      getContract: () => state.contract ?? undefined,
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
    ...(req.wire !== undefined ? { wire: req.wire } : {}),
    ...(req.httpHeaders !== undefined ? { httpHeaders: req.httpHeaders } : {}),
    history,
    artifactType: 'game',
    agentBudget: { maxToolCalls, maxWallClockMs },
    // WS-D — pause the agent at the next safe boundary once it has asked a
    // question (the existing continuation seam: agent.ts aborts cleanly when
    // this returns non-null, yielding output.interrupted=true). 'model_requested'
    // is the canonical reason for an agent-initiated pause.
    getContinuationHint: () => (pendingQuestion !== null ? 'model_requested' : null),
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
    const entry = tree.view('index.html');
    if (entry === null) return null;

    // The genre playbook is the preferred verdict source (an EXTERNAL check the
    // agent didn't author). When the genre has none (genre-less / novel games),
    // fall back to the agent-authored contract so creativity is still verified
    // against its own declared input→state behaviour instead of shipping
    // unverified. Boot + juice stay external regardless.
    const plan = selectGamePlaytestPlan(spec.genre) ?? state.contract;
    const hasPredicates = plan !== null && plan.predicates.length > 0;

    // Inline the WHOLE project into one self-contained HTML before booting it in
    // the browser-worker — exactly like `done`'s gate (inlineForVerify). Passing
    // raw index.html made the worker unable to load a multi-file game's external
    // `src/main.js`, so a perfectly-booting multi-file game reported booted=false
    // with every snapshot field missing → wasted repair rounds + a misleading
    // force-accept. The published game is inlined too, so this also matches what
    // actually ships.
    const verifyHtml = await inlineForVerify(entry.content);

    // The boot check runs REGARDLESS of whether the genre has playbook
    // predicates. Previously a genre with no playbook returned null here and
    // shipped 'no_verdict' — so a game that never booted (window.__game absent)
    // went out as if it were fine (the racing booted=0 case). Now a boot failure
    // always produces a verdict → the repair loop gets a round to fix it.
    const rvVerdict = await browserJobs.runtimeVerify(verifyHtml);
    if (rvVerdict !== null) {
      // Keep the eval observation current with this attempt's boot result so
      // the captured recording reflects the SHIPPED artifact, not a stale
      // earlier round.
      lastRuntimeVerify = {
        booted: rvVerdict.hasGameContract,
        fatalErrors: [...rvVerdict.fatalErrors],
        ...(rvVerdict.juiceScore !== undefined ? { juiceScore: rvVerdict.juiceScore } : {}),
      };
    }
    const fatalErrors: string[] = rvVerdict === null ? [] : [...rvVerdict.fatalErrors];
    if (rvVerdict !== null && !rvVerdict.hasGameContract) {
      fatalErrors.push('Runtime load: window.__game never appeared — the game did not boot.');
    }

    // Plan step 7 — booted cleanly, but the genre has no playbook predicates AND no
    // agent contract. We do NOT fabricate a pass/fail from generic input here: a
    // whole-snapshot "something changed" check can't tell input-driven change from
    // ambient time/animation drift (→ vacuous pass) and can't tell "ignores input"
    // from "responds to inputs we didn't send" (→ false fail) — both LESS honest
    // than no_verdict (adversarial review 2026-06-23, findings M1/M2). So: drive a
    // generic probe ONLY to read whether a debug snapshot is wired. If the game
    // DECLARED gameplay capabilities (it wants a real verdict) but wired none,
    // that's repairable — push the actionable wire-snapshot fatal (same discipline
    // the predicate path applies). Otherwise ship an honest no_verdict.
    if (fatalErrors.length === 0 && !hasPredicates) {
      const caps = spec.capabilities;
      const wantsVerdict =
        caps?.hasFailState === true ||
        caps?.hasEnemies === true ||
        caps?.escalates === true ||
        caps?.hasProgression === true;
      if (!wantsVerdict) return null; // static toy / no declared gameplay → honest no_verdict
      const floor = buildInteractivityFloorPlan();
      const floorPlay = await browserJobs.playtest(verifyHtml, floor.steps);
      if (floorPlay !== null && floorPlay.hasDebugContract === false) {
        return buildRepairVerdict(
          {
            trace: null,
            fatalErrors: [
              'This game declares gameplay (a fail state / enemies / escalation / progression) but exposes no window.__game.debug snapshot, so it cannot be play-verified. Wire it in ONE line: window.__game.debug.track({ score: () => score, player, ... }) (or set window.__game.state.*) exposing the fields your gameplay updates.',
            ],
          },
          [],
        );
      }
      // Snapshot is wired (or unreadable) but there are no predicates to score it
      // against — an interactivity guess would be less honest than admitting we
      // can't verify play. Ship no_verdict.
      return null;
    }

    const playVerdict =
      hasPredicates && plan !== null ? await browserJobs.playtest(verifyHtml, plan.steps) : null;
    // v3.1 (P9 refinement) — a playbook with predicates can ONLY earn a verdict if
    // the game exposed a live debug contract (window.__game.debug.snapshot()).
    // Without it the snapshot is empty, predicates evaluate against nothing, and a
    // null score was being credited as a vacuous PASS (rhythm shipped 'passed' with
    // no snapshot wired). Make the missing contract an explicit, actionable failure
    // so the loop forces the agent to wire it instead of crediting an unverifiable pass.
    if (hasPredicates && playVerdict !== null && playVerdict.hasDebugContract === false) {
      fatalErrors.push(
        'The genre playbook needs window.__game.debug.snapshot() to read game state, but it returned no contract. Wire it in ONE line: call window.__game.debug.track({ score: () => score, player, ... }) (or set window.__game.state.*) exposing the fields the gameplay updates — otherwise the playtest cannot verify your game.',
      );
    }
    const observation: AttemptObservation = {
      trace: playVerdict === null ? null : traceFromPlaytestResult(playVerdict),
      fatalErrors,
    };
    return buildRepairVerdict(observation, hasPredicates && plan !== null ? plan.predicates : []);
  };

  // Round 0 + repair rounds. `history` carries the prior transcript forward so
  // each repair round is a true continuation (the agent sees its own prior
  // work + the concrete failure), not a cold restart.
  const history: ChatMessage[] = [];
  let nextPrompt = req.prompt;
  let output: GenerateOutput = await generate(buildInput(nextPrompt, history), deps);
  let repairRounds = 0;
  let shipReason: ShipReason = 'no_verdict';
  // Phase 5.6 — retain the deterministic verdict for the SHIPPED attempt so the
  // telemetry write below can read its predicate pass/total. Null when no
  // deterministic verdict was obtainable (no port / no spec / no predicates).
  let shippedVerdict: RepairVerdict | null = null;
  // v3.1 — one-shot guard: at ship time, if the agent imported skill modules to
  // src/engine/ but never wired them (the import→use gap P3's auto-wire couldn't
  // close because import_skill runs before the entry file exists), spend ONE
  // bounded repair round forcing wire-or-delete. Capped at one attempt so a
  // stubborn agent can't burn the whole repair budget on it.
  let stagedUnusedRepairDone = false;

  for (;;) {
    const verdict = await observeVerdict();
    shippedVerdict = verdict;
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
    // The verdict's predicates came from the agent's contract (not a genre
    // playbook) when the genre has no bundled playbook and a contract was set.
    // This makes a non-completable creative game gate on its OWN contract.
    const contractAuthored =
      state.spec !== null &&
      selectGamePlaytestPlan(state.spec.genre) === null &&
      state.contract !== null;
    const action = decideRepairAction(verdict, state.spec, {
      roundsRun: repairRounds,
      maxRounds: maxRepairRounds,
      budgetExhausted,
      contractAuthored,
    });
    // v3.1 — before shipping, force one wire-or-delete round for staged-unused
    // skills (imported to disk but never imported+called → dead code the agent
    // paid for while hand-rolling the same system). Only when we'd otherwise ship,
    // have budget + rounds left, and haven't already tried.
    if (
      action.kind === 'ship' &&
      !stagedUnusedRepairDone &&
      !budgetExhausted &&
      repairRounds < maxRepairRounds
    ) {
      const staged = analyzeSkillUsage(tree.toTextFiles()).skillImportedNotCalled;
      if (staged.length > 0) {
        stagedUnusedRepairDone = true;
        history.push(
          { role: 'user', content: nextPrompt },
          { role: 'assistant', content: output.message },
        );
        nextPrompt = buildStagedUnusedInstruction(staged);
        repairRounds += 1;
        output = await generate(buildInput(nextPrompt, history), deps);
        continue;
      }
    }
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

  // v3.1 — dead-skill sweep. The staged-unused repair round (above) gives the
  // agent a chance to wire imported skills; whatever remains PROVABLY unreferenced
  // (its name appears in no other file → it can never be loaded; the game already
  // booted without it) is dropped so the shipped artifact carries no dead modules.
  // Bulletproof gate, so this cannot break the booted game. The import_skill TOOL
  // count stays in telemetry (importWithoutUse/skillsImported), so the adoption
  // MISS is still measured — only the dead file is removed.
  const removedDeadSkills: string[] = [];
  const deadBases = new Set(analyzeSkillUsage(tree.toTextFiles()).unreferencedEngineFiles);
  if (deadBases.size > 0) {
    for (const f of tree.toTextFiles()) {
      if (!/^src\/engine\/.+\.(jsx?|mjs)$/.test(f.path)) continue;
      const base = (f.path.split('/').pop() ?? '').replace(/\.(jsx?|mjs)$/, '');
      if (deadBases.has(base) && tree.delete(f.path)) removedDeadSkills.push(base);
    }
  }

  await assertGeneratedJavaScriptSyntax(tree.toTextFiles());

  // Deterministically correct near-miss engine CDN URLs before persisting (e.g.
  // the model writing `phaser-esm.js` instead of `phaser.esm.js`, which 404s so
  // the game never boots and the preview is blank). Fixing the bytes here means
  // every consumer — preview, publish, export, ZIP, runtime-verify — gets a
  // bootable artifact. (engine-cdn)
  for (const f of tree.toTextFiles()) {
    if (!f.path.endsWith('.html')) continue;
    const fixed = normalizeEngineCdnUrls(f.content);
    if (fixed !== f.content) tree.create(f.path, fixed);
  }

  const snapshot = await tree.persist(ports.store);

  const encoder = new TextEncoder();
  const fsState = tree.toSnapshotInput().map((f) => ({
    path: f.path,
    bytes:
      f.bytes instanceof Uint8Array ? f.bytes.length : encoder.encode(f.bytes as string).length,
  }));

  // ── #5.6 — per-run quality telemetry (best-effort, NON-FATAL) ─────────────
  // Assemble ONE row from the deterministic data already in hand and hand it to
  // the injectable sink. force_accept = the run shipped WITHOUT a passing
  // deterministic verdict (a verdict existed but did not pass — repair/budget
  // exhausted). When no deterministic verdict was ever obtainable
  // (no_verdict / skipped_non_completable), there was no gate to force past, so
  // force_accept stays false. The whole write is wrapped: a telemetry failure
  // must NEVER fail a generation.

  // ── Structured per-run build report (telemetry: learn from every run) ───────
  // One greppable JSON line carrying HOW the game was built — spec shape, the
  // tool/skill histogram, the quality-gate verdict + invariant warnings, the
  // novelty path (contract/tweak), tokens. Emitted unconditionally + persisted
  // to run_quality_metrics.report.
  const sig = signal.snapshot();
  const reportScore = shippedVerdict?.score ?? null;
  // Phase 3/4/9 telemetry — did the agent ignore the skills we recommended for
  // its declared capabilities (re-derivation), and did it escape the declared
  // engine with a decoy entry? These feed the run-report analyzer.
  const recommended =
    state.spec?.capabilities && state.engine && state.engine !== 'canvas2d'
      ? recommendSkills(state.spec.capabilities, state.engine, state.spec.genre)
      : [];
  // v3 P1 — count a skill as adopted if it was EITHER viewed (view_game_feel) OR
  // imported (import_skill). Pre-v3 this only checked skillsViewed, so every
  // imported skill was mis-counted "unused" (the metric went blind to P1).
  const adopted = new Set([...sig.skillsViewed, ...sig.skillsImported]);
  // v3 P5 — only the "import now" core tier (first 3, emitted core-first) counts
  // as missed adoption; the long "also available" tail shouldn't penalise a run
  // for a skipped polish skill.
  const recommendedButUnused = recommended
    .slice(0, 3)
    .filter((r) => !adopted.has(r.skill))
    .map((r) => r.skill);
  const engineEscaped = sig.invariantWarnings.includes('decoy-engine');
  // v3 P2 — code-usage signals (was hand-greped): did the imported skills get
  // imported + CALLED, or written to disk and abandoned?
  const usage = analyzeSkillUsage(tree.toTextFiles());
  // v3 P10a — cache-weighted cost. usedInputTokens is FRESH (uncached) input, so
  // the total input for pricing is fresh + cacheRead + cacheWrite. totalTokens
  // (uncached input + output) is kept for back-compat but cost should rank by USD.
  const costUsd = computeImpliedCost(
    {
      inputTokens: usedInputTokens + usedCacheReadTokens + usedCacheWriteTokens,
      outputTokens: usedOutputTokens,
      cachedInputTokens: usedCacheReadTokens,
      cacheCreationInputTokens: usedCacheWriteTokens,
    },
    req.model?.modelId ?? null,
  );
  const billedInput = usedInputTokens + usedCacheReadTokens + usedCacheWriteTokens;
  const buildReport = {
    genre: state.spec?.genre ?? null,
    engine: state.engine,
    dimensions: state.spec?.dimensions ?? null,
    winCondition: state.spec?.winCondition ?? null,
    capabilities: state.spec?.capabilities ?? null,
    fileCount: tree.size,
    shipReason,
    forceAccept: shippedVerdict !== null && !shippedVerdict.pass,
    repairRounds,
    runtimeBooted: lastRuntimeVerify === undefined ? null : lastRuntimeVerify.booted,
    juiceScore: lastRuntimeVerify?.juiceScore ?? null,
    playbookPass: reportScore === null ? 0 : reportScore.results.length - reportScore.failures,
    playbookTotal: reportScore === null ? 0 : reportScore.results.length,
    inputTokens: usedInputTokens,
    outputTokens: usedOutputTokens,
    totalTokens: usedInputTokens + usedOutputTokens,
    // v3 P10a cost telemetry
    costUsd,
    cachedInputTokens: usedCacheReadTokens,
    cacheCreationInputTokens: usedCacheWriteTokens,
    cacheHitRate: billedInput > 0 ? usedCacheReadTokens / billedInput : 0,
    // v3 P2 code-usage signals
    engineFilesWritten: usage.engineFilesWritten,
    engineImports: usage.engineImports,
    usesSkillFns: usage.usesSkillFns,
    debugWired: usage.debugWired,
    skillImportedNotCalled: usage.skillImportedNotCalled,
    importWithoutUse: sig.skillsImported.length > 0 && usage.engineImports === 0,
    removedDeadSkills, // v3.1 — provably-unreferenced staged modules swept at ship
    removedDeadSkillCount: removedDeadSkills.length,
    recommendedButUnused,
    engineEscaped,
    ...sig,
  };
  console.log(`[build-report] ${JSON.stringify(buildReport)}`);

  if (ports.recordRunQuality !== undefined) {
    const score = shippedVerdict?.score ?? null;
    const metrics: RunQualityMetrics = {
      genre: state.spec?.genre ?? null,
      forceAccept: shippedVerdict !== null && !shippedVerdict.pass,
      repairRounds,
      shipReason,
      playbookPass: score === null ? 0 : score.results.length - score.failures,
      playbookTotal: score === null ? 0 : score.results.length,
      juiceScore: lastRuntimeVerify?.juiceScore ?? null,
      runtimeBooted: lastRuntimeVerify === undefined ? null : lastRuntimeVerify.booted,
      report: buildReport,
    };
    // Per-predicate telemetry — WHICH predicates passed/failed (+ the
    // observed-vs-expected reason on failures), so a quality regression is
    // diagnosable from the logs/data rather than re-derived by hand.
    const predicateSummary =
      score === null
        ? 'none'
        : score.results
            .map((r) => `${r.predicate.field}:${r.predicate.op}=${r.pass ? 'ok' : 'FAIL'}`)
            .join(' ');
    console.log(
      `[run-quality] genre=${metrics.genre ?? 'n/a'} booted=${metrics.runtimeBooted} ` +
        `ship=${shipReason} forceAccept=${metrics.forceAccept} repair=${repairRounds} ` +
        `playbook=${metrics.playbookPass}/${metrics.playbookTotal} juice=${metrics.juiceScore ?? 'n/a'} ` +
        `predicates=[${predicateSummary}]`,
    );
    if (score !== null && score.failures > 0) {
      for (const r of score.results.filter((x) => !x.pass)) {
        console.log(`[run-quality]   FAIL ${r.predicate.field} ${r.predicate.op}: ${r.reason}`);
      }
    }
    if (
      (metrics.runtimeBooted === false || shipReason === 'no_verdict') &&
      metrics.playbookTotal === 0
    ) {
      // Surface the coverage gap that the report data revealed: a genre shipping
      // with no deterministic gate. Makes the "needs a playbook" signal greppable.
      console.log(
        `[run-quality]   COVERAGE-GAP genre=${metrics.genre ?? 'n/a'} has no playbook predicates (shipped on boot+juice only).`,
      );
    }
    try {
      await ports.recordRunQuality(metrics);
    } catch (err) {
      console.error(`[run-generation] quality telemetry write failed (non-fatal): ${String(err)}`);
    }
  }

  return {
    output,
    engine: state.engine,
    spec: state.spec,
    snapshot,
    fileCount: tree.size,
    fsState,
    repairRounds,
    shipReason,
    usage: {
      inputTokens: usedInputTokens,
      outputTokens: usedOutputTokens,
      totalTokens: usedInputTokens + usedOutputTokens,
      cacheReadTokens: usedCacheReadTokens,
      cacheWriteTokens: usedCacheWriteTokens,
    },
    pendingQuestion,
    ...(lastRuntimeVerify !== undefined ? { runtimeVerify: lastRuntimeVerify } : {}),
  };
}
