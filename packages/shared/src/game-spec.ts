/**
 * may9 Phase 4 — Game spec schema.
 *
 * The agent emits a GameSpec via the `declare_game_spec` tool BEFORE
 * touching the engine, files, or anything else. The spec is persisted on
 * the next snapshot and re-injected into the system prompt on every
 * follow-up turn so feature-level invariants (e.g. "vault: manual
 * trigger, directional, animated") survive across edits without the
 * user re-stating them. This addresses defect D6 from docs/may9.md §0b
 * and the brawler `c44763af…` 6-correction class of failure.
 *
 * `amend_game_spec` accepts a partial patch; the renderer + IPC layer
 * preserve untouched features verbatim.
 */
import { z } from 'zod';

export const GAME_SPEC_SCHEMA_VERSION = 1 as const;

export const GameGenre = z.enum([
  'platformer',
  'topdown_arcade',
  'fps',
  'tps',
  'fighting',
  'puzzle',
  'runner',
  'rpg',
  'shmup',
  'racing',
  'tower_defense',
  'visual_novel',
  'roguelike',
  'sandbox',
  'tycoon',
  'rhythm',
  'idle',
  'other',
]);
export type GameGenre = z.infer<typeof GameGenre>;

export const GameDimensions = z.enum(['2d', '2_5d', '3d']);
export type GameDimensions = z.infer<typeof GameDimensions>;

export const GamePerspective = z.enum([
  'side_scroll',
  'top_down',
  'isometric',
  'first_person',
  'third_person',
  'fixed_screen',
  'orbital',
]);
export type GamePerspective = z.infer<typeof GamePerspective>;

export const GameCameraKind = z.enum([
  'static',
  'follow_horizontal',
  'follow_2d',
  'follow_3d',
  'first_person',
  'third_person',
  'orbital',
  'parallax',
]);
export type GameCameraKind = z.infer<typeof GameCameraKind>;

export const GameInputKind = z.enum(['keyboard', 'mouse', 'pointer_lock', 'touch', 'gamepad']);
export type GameInputKind = z.infer<typeof GameInputKind>;

/**
 * Free-form per-feature spec. Keys are user-meaningful feature names
 * (e.g. "vault", "melee", "reload_hud") chosen by the agent. Values
 * carry the invariants the follow-up turns must preserve unless the
 * user explicitly amends them.
 *
 * Intentionally permissive — too tight a schema here would force the
 * agent to fight the type system instead of writing the game. The Phase
 * 4 carry-forward logic only needs to round-trip the JSON.
 */
export const GameFeatureSpec = z.record(
  z
    .union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()])
    .describe('Primitive or string array — keep human-readable.'),
);
export type GameFeatureSpec = z.infer<typeof GameFeatureSpec>;

/**
 * Capability/trait model (Engine Evolution Phase 1) — the genre-AGNOSTIC,
 * composable description of what a game actually DOES. This is the primary axis
 * the engine reasons about (skill recommendation, escalation/feedback checks,
 * engine fit); `genre` becomes a derived hint, not a gate. A user's novel idea
 * ("you are the tide guiding boats") has no genre but DOES have capabilities
 * ({ controlScheme: 'drag', mechanics: ['guide'], hasFailState: true }), so the
 * engine can serve it without forcing it into a box.
 *
 * Optional on GameSpec for back-compat; when omitted, helpers fall back to the
 * genre heuristics. Booleans drive verification + push-model skill recommendation.
 */
export const GameControlScheme = z.enum([
  'keyboard',
  'pointer',
  'twin_stick',
  'touch',
  'drag',
  'gamepad',
  'hybrid',
]);
export type GameControlScheme = z.infer<typeof GameControlScheme>;

export const GameCapabilities = z.object({
  /** Open mechanic vocabulary — what the player DOES (shoot/place/dodge/collect/
   *  build/guide/grow/solve/race/dialogue/manage…). Drives skill recommendation. */
  mechanics: z.array(z.string()).default([]),
  /** How the player provides input — the source of truth for controls scaffolding. */
  controlScheme: GameControlScheme.optional(),
  /** Difficulty ramps over time/waves (the anti-flat-game trait). */
  escalates: z.boolean().default(false),
  /** Has hostile actors with behaviour (drives enemy-ai recommendation). */
  hasEnemies: z.boolean().default(false),
  /** The player can lose. */
  hasFailState: z.boolean().default(false),
  /** Levels / stages / unlocks / persistent progress. */
  hasProgression: z.boolean().default(false),
  /** Story / dialogue / cutscenes. */
  hasNarrative: z.boolean().default(false),
  /** Currency / resources / shop / placement cost. */
  hasEconomy: z.boolean().default(false),
  /** Physics-driven motion (gravity, collisions, forces). */
  hasPhysics: z.boolean().default(false),
  /** Procedurally / randomly generated content. */
  procedural: z.boolean().default(false),
});
export type GameCapabilities = z.infer<typeof GameCapabilities>;

/** Patch shape for `amend_game_spec` capabilities — every field optional with NO
 *  defaults, so a partial amend carries ONLY the fields the agent restated and
 *  `applyGameSpecPatch` deep-merges them onto the prior capabilities. (Using the
 *  defaulting GameCapabilities here would silently reset every un-restated trait
 *  to false/[] on a partial amend.) */
export const GameCapabilitiesPatch = z.object({
  mechanics: z.array(z.string()).optional(),
  controlScheme: GameControlScheme.optional(),
  escalates: z.boolean().optional(),
  hasEnemies: z.boolean().optional(),
  hasFailState: z.boolean().optional(),
  hasProgression: z.boolean().optional(),
  hasNarrative: z.boolean().optional(),
  hasEconomy: z.boolean().optional(),
  hasPhysics: z.boolean().optional(),
  procedural: z.boolean().optional(),
});
export type GameCapabilitiesPatch = z.infer<typeof GameCapabilitiesPatch>;

export const GameSpec = z.object({
  schemaVersion: z.literal(GAME_SPEC_SCHEMA_VERSION).default(GAME_SPEC_SCHEMA_VERSION),
  genre: GameGenre,
  /** Composable capabilities — the primary genre-agnostic description (Phase 1). */
  capabilities: GameCapabilities.optional(),
  dimensions: GameDimensions,
  perspective: GamePerspective,
  cameraKind: GameCameraKind,
  primaryInputs: z.array(GameInputKind).min(1),
  numActors: z.number().int().min(1).max(64),
  winCondition: z
    .string()
    .min(3)
    .max(280)
    .describe('One sentence on how the player wins. "—" if endless.'),
  loseCondition: z
    .string()
    .min(3)
    .max(280)
    .describe('One sentence on how the player loses. "—" if no fail state.'),
  features: z
    .record(GameFeatureSpec)
    .default({})
    .describe(
      'Map of named feature → invariants. The agent commits to these and ' +
        'follow-up turns MUST preserve them unless an explicit amend_game_spec ' +
        'patches the named feature.',
    ),
});
export type GameSpec = z.infer<typeof GameSpec>;

/** Partial patch shape used by `amend_game_spec`. All top-level fields
 *  optional; `features` is merged shallow (per-key replace, not deep
 *  merge — the agent must restate the full feature spec when amending
 *  it, so partial-update bugs can't quietly drop invariants). */
export const GameSpecPatch = z.object({
  genre: GameGenre.optional(),
  capabilities: GameCapabilitiesPatch.optional(),
  dimensions: GameDimensions.optional(),
  perspective: GamePerspective.optional(),
  cameraKind: GameCameraKind.optional(),
  primaryInputs: z.array(GameInputKind).min(1).optional(),
  numActors: z.number().int().min(1).max(64).optional(),
  winCondition: z.string().min(3).max(280).optional(),
  loseCondition: z.string().min(3).max(280).optional(),
  features: z.record(GameFeatureSpec).optional(),
  /** Optional human-readable note on WHY the amend was needed. Stored
   *  for audit only. */
  reason: z.string().max(500).optional(),
});
export type GameSpecPatch = z.infer<typeof GameSpecPatch>;

/** Apply a patch on top of an existing spec. `features` keys are
 *  per-key replaced — the agent restates the full FeatureSpec for any
 *  feature it changes — and untouched features pass through verbatim
 *  from the prior turn. Returns a freshly validated GameSpec or throws.
 */
export function applyGameSpecPatch(prior: GameSpec, patch: GameSpecPatch): GameSpec {
  // Capabilities deep-merge onto the prior set — a partial amend restates only
  // the traits that changed; the rest pass through (NOT reset to defaults). The
  // cast is for TS only; GameSpec.parse(merged) below re-validates + fills any
  // genuinely-missing defaults when the prior had no capabilities.
  const mergedCapabilities: GameCapabilities | undefined =
    patch.capabilities !== undefined
      ? ({ ...(prior.capabilities ?? {}), ...patch.capabilities } as GameCapabilities)
      : prior.capabilities;
  const merged: GameSpec = {
    ...prior,
    ...(patch.genre !== undefined ? { genre: patch.genre } : {}),
    ...(mergedCapabilities !== undefined ? { capabilities: mergedCapabilities } : {}),
    ...(patch.dimensions !== undefined ? { dimensions: patch.dimensions } : {}),
    ...(patch.perspective !== undefined ? { perspective: patch.perspective } : {}),
    ...(patch.cameraKind !== undefined ? { cameraKind: patch.cameraKind } : {}),
    ...(patch.primaryInputs !== undefined ? { primaryInputs: patch.primaryInputs } : {}),
    ...(patch.numActors !== undefined ? { numActors: patch.numActors } : {}),
    ...(patch.winCondition !== undefined ? { winCondition: patch.winCondition } : {}),
    ...(patch.loseCondition !== undefined ? { loseCondition: patch.loseCondition } : {}),
    features: { ...prior.features, ...(patch.features ?? {}) },
  };
  return GameSpec.parse(merged);
}

/**
 * Engine ↔ spec capability matrix. Returns a fit verdict:
 *   - 'ok'   — engine is a natural fit for this spec
 *   - 'warn' — engine can do it but is not the best choice
 *   - 'reject' — engine cannot reasonably do it; pick a different one
 *
 * Driven by the `choose_engine` gate (Phase 4). 2D briefs prefer phaser;
 * 3D briefs prefer three. FPS on Phaser returns 'warn'; FPS on Three
 * returns 'ok'.
 */
export type EngineFitVerdict = 'ok' | 'warn' | 'reject';

export interface EngineFit {
  verdict: EngineFitVerdict;
  reason: string;
}

export type GameEngineId = 'three' | 'phaser';

export function checkEngineFit(spec: GameSpec, engine: GameEngineId): EngineFit {
  // 3D briefs: phaser is 2.5D-only, so real 3D belongs on three.
  if (spec.dimensions === '3d' && engine === 'phaser') {
    return {
      verdict: 'warn',
      reason: 'Phaser supports 2.5D layering only. For real 3D pick three.',
    };
  }

  // Genre-specific gates.
  if (spec.genre === 'fps' && engine === 'phaser') {
    return {
      verdict: 'warn',
      reason: 'Phaser FPS is fake-3D raycaster territory. Three is the natural choice.',
    };
  }

  // Camera-kind gates (catch the "FPS without first-person" misconfig).
  if (spec.cameraKind === 'first_person' && spec.perspective !== 'first_person') {
    return {
      verdict: 'warn',
      reason:
        'cameraKind=first_person but perspective is not first_person — restate the spec to keep them aligned.',
    };
  }

  return { verdict: 'ok', reason: 'Engine fits the spec.' };
}
