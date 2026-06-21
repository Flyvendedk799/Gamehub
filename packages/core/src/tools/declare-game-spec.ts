/**
 * may9 Phase 4 — `declare_game_spec` agent tool.
 *
 * The agent emits this BEFORE `choose_engine` and BEFORE touching any
 * file. The spec captures genre / dimensions / perspective / camera /
 * inputs / actors / win+lose conditions / per-feature invariants. The
 * host persists the validated spec on the next snapshot via
 * `setSpec(spec)` so follow-up turns can re-inject it into the system
 * prompt and `choose_engine` can validate engine fit.
 *
 * Refusing to emit a spec is not an option: the system prompt forbids
 * `text_editor.create` / `choose_engine` until this tool returns
 * successfully.
 */

import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { GAME_SPEC_SCHEMA_VERSION, GameSpec, validateCapabilities } from '@playforge/shared';
import { Type } from '@sinclair/typebox';

const FeatureValue = Type.Union([
  Type.String(),
  Type.Number(),
  Type.Boolean(),
  Type.Array(Type.String()),
  Type.Null(),
]);
const FeatureRecord = Type.Record(Type.String(), FeatureValue);

/** Capability/trait model (Engine Evolution Phase 1) — the genre-agnostic
 *  description of what the game DOES. Drives skill recommendation + verification.
 *  All fields optional; declare the ones that describe your idea. */
const CapabilitiesSchema = Type.Object({
  mechanics: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'What the player DOES — open vocabulary: shoot, place, dodge, collect, build, guide, grow, solve, race, dialogue, manage…',
    }),
  ),
  controlScheme: Type.Optional(
    Type.Union([
      Type.Literal('keyboard'),
      Type.Literal('pointer'),
      Type.Literal('twin_stick'),
      Type.Literal('touch'),
      Type.Literal('drag'),
      Type.Literal('gamepad'),
      Type.Literal('hybrid'),
    ]),
  ),
  escalates: Type.Optional(Type.Boolean({ description: 'Difficulty ramps over time/waves.' })),
  hasEnemies: Type.Optional(Type.Boolean()),
  hasFailState: Type.Optional(Type.Boolean()),
  hasProgression: Type.Optional(Type.Boolean({ description: 'Levels / stages / unlocks.' })),
  hasNarrative: Type.Optional(Type.Boolean()),
  hasEconomy: Type.Optional(Type.Boolean()),
  hasPhysics: Type.Optional(Type.Boolean()),
  procedural: Type.Optional(Type.Boolean()),
  requiresNetworking: Type.Optional(
    Type.Boolean({ description: 'Online/networked multiplayer is implied (co-op/versus/.io).' }),
  ),
});

const DeclareGameSpecParams = Type.Object({
  genre: Type.Union([
    Type.Literal('platformer'),
    Type.Literal('topdown_arcade'),
    Type.Literal('fps'),
    Type.Literal('tps'),
    Type.Literal('fighting'),
    Type.Literal('puzzle'),
    Type.Literal('runner'),
    Type.Literal('rpg'),
    Type.Literal('shmup'),
    Type.Literal('racing'),
    Type.Literal('tower_defense'),
    Type.Literal('visual_novel'),
    Type.Literal('roguelike'),
    Type.Literal('sandbox'),
    Type.Literal('tycoon'),
    Type.Literal('rhythm'),
    Type.Literal('idle'),
    Type.Literal('other'),
  ]),
  dimensions: Type.Union([Type.Literal('2d'), Type.Literal('2_5d'), Type.Literal('3d')]),
  perspective: Type.Union([
    Type.Literal('side_scroll'),
    Type.Literal('top_down'),
    Type.Literal('isometric'),
    Type.Literal('first_person'),
    Type.Literal('third_person'),
    Type.Literal('fixed_screen'),
    Type.Literal('orbital'),
  ]),
  cameraKind: Type.Union([
    Type.Literal('static'),
    Type.Literal('follow_horizontal'),
    Type.Literal('follow_2d'),
    Type.Literal('follow_3d'),
    Type.Literal('first_person'),
    Type.Literal('third_person'),
    Type.Literal('orbital'),
    Type.Literal('parallax'),
  ]),
  primaryInputs: Type.Array(
    Type.Union([
      Type.Literal('keyboard'),
      Type.Literal('mouse'),
      Type.Literal('pointer_lock'),
      Type.Literal('touch'),
      Type.Literal('gamepad'),
    ]),
    { minItems: 1 },
  ),
  numActors: Type.Integer({ minimum: 1, maximum: 64 }),
  winCondition: Type.String({ minLength: 3, maxLength: 280 }),
  loseCondition: Type.String({ minLength: 3, maxLength: 280 }),
  capabilities: Type.Optional(CapabilitiesSchema),
  features: Type.Optional(Type.Record(Type.String(), FeatureRecord)),
});

export interface DeclareGameSpecDetails {
  schemaVersion: 1;
  genre: string;
  dimensions: string;
  perspective: string;
  cameraKind: string;
  inputs: number;
  actors: number;
  features: number;
}

export type SetGameSpecFn = (spec: import('@playforge/shared').GameSpec) => void | Promise<void>;

export function makeDeclareGameSpecTool(
  setSpec: SetGameSpecFn | undefined,
): AgentTool<typeof DeclareGameSpecParams, DeclareGameSpecDetails> {
  return {
    name: 'declare_game_spec',
    label: 'Declare game spec',
    description:
      'MANDATORY first step in every game run. Declare the spec — genre, dimensions, perspective, camera, ' +
      'inputs, actors, win/lose conditions, and per-feature invariants — BEFORE calling choose_engine or ' +
      'text_editor. The spec is persisted on the next snapshot and re-injected on every follow-up turn so ' +
      'feature invariants (e.g. "vault: manual trigger, directional, animated") survive across edits without ' +
      'the user re-stating them. Use amend_game_spec for follow-up changes — never restate the whole spec.',
    parameters: DeclareGameSpecParams,
    async execute(_toolCallId, params): Promise<AgentToolResult<DeclareGameSpecDetails>> {
      const candidate = {
        schemaVersion: GAME_SPEC_SCHEMA_VERSION,
        ...params,
        features: params.features ?? {},
      };
      const parsed = GameSpec.parse(candidate);
      // v2 P4 — reconcile self-declared capability flags against genre/scheme and
      // demote the ones they contradict (e.g. escalates on a handcrafted-level
      // platformer), so the escalation invariant + recommender act on clean flags.
      const { corrected, conflicts } = validateCapabilities(parsed);
      const spec =
        corrected !== undefined && corrected !== parsed.capabilities
          ? { ...parsed, capabilities: corrected }
          : parsed;
      if (setSpec !== undefined) {
        await setSpec(spec);
      }
      const featureNames = Object.keys(spec.features);
      const featuresLine =
        featureNames.length > 0
          ? `Features pinned: ${featureNames.join(', ')}.`
          : 'No per-feature invariants yet.';
      const conflictLine = conflicts.length > 0 ? ` Capability check: ${conflicts.join(' ')}` : '';
      return {
        content: [
          {
            type: 'text',
            text: `Spec recorded: ${spec.genre}/${spec.dimensions} (${spec.perspective}, camera=${spec.cameraKind}). ${spec.numActors} actor(s), inputs=${spec.primaryInputs.join('+')}. ${featuresLine}${conflictLine} Now call choose_engine.`,
          },
        ],
        details: {
          schemaVersion: 1,
          genre: spec.genre,
          dimensions: spec.dimensions,
          perspective: spec.perspective,
          cameraKind: spec.cameraKind,
          inputs: spec.primaryInputs.length,
          actors: spec.numActors,
          features: featureNames.length,
        },
      };
    },
  };
}
