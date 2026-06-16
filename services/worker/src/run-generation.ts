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
  type GenerateInput,
  type GenerateOutput,
  type GenerateViaAgentDeps,
  generateViaAgent,
} from '@playforge/agent-core';
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
  engine: 'three' | 'phaser' | 'pygame' | 'godot',
  files: ReadonlyArray<{ path: string; content: string }>,
) => { ok: boolean; engine: 'three' | 'phaser' | 'pygame' | 'godot'; issues: SceneIssue[] };

export interface GenerationRequest {
  prompt: string;
  model: ModelRef;
  apiKey: string;
  /** Optional pre-pick; when omitted the agent calls choose_engine itself. */
  engine?: WebEngine;
  /** Seed the working tree (e.g. a remix's parent snapshot). */
  initialFiles?: Iterable<readonly [string, string]>;
}

export interface GenerationPorts {
  store: SnapshotStore;
  onEvent?: (event: AgentEvent) => void;
  /** Injectable agent runner. Defaults to the real generateViaAgent. */
  generate?: GenerateFn;
  /** Engine scene validator. Defaults to a permissive pass. */
  validateScene?: SceneValidator;
}

export interface GenerationResult {
  output: GenerateOutput;
  engine: WebEngine | null;
  spec: GameSpec | null;
  snapshot: WriteResult;
  fileCount: number;
  /** File listing at run end — used to build continuation fsState. */
  fsState: Array<{ path: string; bytes: number }>;
}

const PASS_VALIDATOR: SceneValidator = (engine) => ({ ok: true, engine, issues: [] });

export async function runGeneration(
  req: GenerationRequest,
  ports: GenerationPorts,
): Promise<GenerationResult> {
  const generate = ports.generate ?? generateViaAgent;
  const validateScene = ports.validateScene ?? PASS_VALIDATOR;
  const tree = new WorkingTree(req.initialFiles);

  // In-run mutable state the agent reads/writes via the gameMode callbacks and
  // that we persist alongside the snapshot once the run completes.
  const state: { engine: WebEngine | null; spec: GameSpec | null } = {
    engine: req.engine ?? null,
    spec: null,
  };

  const deps: GenerateViaAgentDeps = {
    fs: tree,
    ...(ports.onEvent ? { onEvent: ports.onEvent } : {}),
    gameMode: {
      setEngine: (engine) => {
        if (engine === 'three' || engine === 'phaser') state.engine = engine;
      },
      getCurrentEngine: () => state.engine,
      validate: (engine, files) => validateScene(engine, files),
      setSpec: (spec) => {
        state.spec = spec;
      },
      getSpec: () => state.spec ?? undefined,
    },
  };

  const input: GenerateInput = {
    prompt: req.prompt,
    model: req.model,
    apiKey: req.apiKey,
    history: [],
    artifactType: 'game',
    ...(req.engine ? { engine: req.engine } : {}),
  };

  const output = await generate(input, deps);
  const snapshot = await tree.persist(ports.store);

  const encoder = new TextEncoder();
  const fsState = tree.toSnapshotInput().map((f) => ({
    path: f.path,
    bytes: f.bytes instanceof Uint8Array ? f.bytes.length : encoder.encode(f.bytes as string).length,
  }));

  return { output, engine: state.engine, spec: state.spec, snapshot, fileCount: tree.size, fsState };
}
