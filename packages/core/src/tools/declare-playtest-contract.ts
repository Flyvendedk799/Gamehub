/**
 * `declare_playtest_contract` agent tool — verifiable contracts for genre-LESS
 * games.
 *
 * The genre playbooks deterministically gate the known shapes (platformer, fps,
 * shmup, …). A game that doesn't fit a genre (`genre: 'other'`, or any genre with
 * no bundled playbook) would otherwise ship `no_verdict` — checked for BOOT but
 * never for PLAY. This tool lets the agent declare its OWN input→state checks for
 * the game it is ABOUT to build; the boot-and-repair loop then scores the game
 * against them with the same pure `scorePlaytest` the genre path uses.
 *
 * Integrity: the contract is a PRE-BUILD commitment — the system prompt requires
 * it right after `declare_game_spec` (before any file is written), so it is a
 * contract-against-itself ("dragging WILL raise `progress`"), not a post-hoc
 * description of whatever got built. Boot + juice remain external checks.
 */

import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
import {
  type AuthoredContract,
  type AuthoredContractCheck,
  type GamePlaytestPlan,
  planFromContract,
} from '../playtest-planner.js';

const CheckParams = Type.Object({
  action: Type.Union(
    [
      Type.Literal('key'),
      Type.Literal('pointerMove'),
      Type.Literal('pointerDown'),
      Type.Literal('pointerUp'),
      Type.Literal('wait'),
    ],
    { description: 'The synthetic input to dispatch for this step.' },
  ),
  key: Type.Optional(
    Type.String({
      description: 'KeyboardEvent.code for action:"key" (e.g. "Space", "ArrowLeft").',
    }),
  ),
  holdFrames: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 240,
      description: 'Frames to hold a key / advance a wait.',
    }),
  ),
  x: Type.Optional(Type.Number({ description: 'Normalised pointer x (0..1) for pointerMove.' })),
  y: Type.Optional(Type.Number({ description: 'Normalised pointer y (0..1) for pointerMove.' })),
  assertField: Type.Optional(
    Type.String({
      description:
        'Dotted snapshot path to verify AFTER this input, e.g. "progress", "score", "playerPos.x". The game MUST expose it in window.__game.debug.snapshot().',
    }),
  ),
  assertOp: Type.Optional(
    Type.Union([
      Type.Literal('increases'),
      Type.Literal('decreases'),
      Type.Literal('changes'),
      Type.Literal('unchanged'),
      Type.Literal('greaterThan'),
      Type.Literal('lessThan'),
      Type.Literal('equals'),
    ]),
  ),
  assertValue: Type.Optional(
    Type.Number({ description: 'Comparison number for greaterThan / lessThan / equals.' }),
  ),
  assertVsPrevious: Type.Optional(
    Type.Boolean({
      description:
        'Compare against the PREVIOUS asserting check instead of the pre-input baseline (for round-trips like move-left-then-right). Default false.',
    }),
  ),
  note: Type.Optional(Type.String({ description: 'Human-readable intent for this check.' })),
});

const DeclarePlaytestContractParams = Type.Object({
  intent: Type.String({
    minLength: 1,
    description: 'One sentence: what core interaction loop this contract proves.',
  }),
  checks: Type.Array(CheckParams, {
    minItems: 2,
    maxItems: 12,
    description:
      'Ordered input→state checks. At least one MUST carry assertField+assertOp (else nothing is verified).',
  }),
});

interface DeclarePlaytestContractDetails {
  predicates: number;
  steps: number;
  fields: string[];
}

export type SetGameContractFn = (plan: GamePlaytestPlan) => void | Promise<void>;
export type GetGameContractFn = () => GamePlaytestPlan | undefined;

const LITERAL_OPS = new Set(['greaterThan', 'lessThan', 'equals']);

export function makeDeclarePlaytestContractTool(
  setContract: SetGameContractFn | undefined,
): AgentTool<typeof DeclarePlaytestContractParams, DeclarePlaytestContractDetails> {
  return {
    name: 'declare_playtest_contract',
    label: 'Declare playtest contract',
    description:
      'For a game that does NOT fit a built-in genre playbook (genre "other", or a niche genre): declare your ' +
      'own input→state checks so the game can be deterministically verified — call this RIGHT AFTER ' +
      'declare_game_spec and BEFORE writing any file. Each check names a synthetic input and (optionally) a ' +
      'snapshot field that must change as a result. It is a pre-build commitment: build the game so each ' +
      'asserted field is exposed in window.__game.debug.snapshot() and responds exactly as declared. Without ' +
      'a contract a genre-less game can only ever ship "no_verdict" (boot-checked but not play-checked).',
    parameters: DeclarePlaytestContractParams,
    async execute(_toolCallId, params): Promise<AgentToolResult<DeclarePlaytestContractDetails>> {
      const { checks } = params;

      const hasAssertion = checks.some((c) => c.assertField && c.assertOp);
      if (!hasAssertion) {
        throw new Error(
          'declare_playtest_contract needs at least ONE check with assertField + assertOp — otherwise nothing is verified. ' +
            'Example: {action:"key", key:"ArrowUp", assertField:"speed", assertOp:"increases"}.',
        );
      }
      for (const c of checks) {
        if (c.action === 'key' && (c.key === undefined || c.key.length === 0)) {
          throw new Error(
            'A check with action:"key" must provide "key" (a KeyboardEvent.code such as "Space", "ArrowLeft", "KeyW").',
          );
        }
        if (c.assertField !== undefined && c.assertField.length > 0 && c.assertOp === undefined) {
          throw new Error(
            `The check on field "${c.assertField}" needs an assertOp (increases/decreases/changes/unchanged/greaterThan/lessThan/equals).`,
          );
        }
        if (
          c.assertOp !== undefined &&
          LITERAL_OPS.has(c.assertOp) &&
          c.assertValue === undefined
        ) {
          throw new Error(
            `assertOp:"${c.assertOp}" must include assertValue (the number to compare against).`,
          );
        }
      }

      const contract: AuthoredContract = {
        intent: params.intent,
        checks: checks.map(
          (c): AuthoredContractCheck => ({
            action: c.action,
            ...(c.key !== undefined ? { key: c.key } : {}),
            ...(c.holdFrames !== undefined ? { holdFrames: c.holdFrames } : {}),
            ...(c.x !== undefined ? { x: c.x } : {}),
            ...(c.y !== undefined ? { y: c.y } : {}),
            ...(c.assertField !== undefined ? { assertField: c.assertField } : {}),
            ...(c.assertOp !== undefined ? { assertOp: c.assertOp } : {}),
            ...(c.assertValue !== undefined ? { assertValue: c.assertValue } : {}),
            ...(c.assertVsPrevious !== undefined ? { assertVsPrevious: c.assertVsPrevious } : {}),
          }),
        ),
      };

      const plan = planFromContract(contract);
      if (plan.predicates.length === 0) {
        throw new Error(
          'The contract produced no machine-checkable predicates. Give at least one check a numeric assertField ' +
            '(e.g. "score", "progress", "playerPos.x") with an assertOp.',
        );
      }

      const fields = [...new Set(plan.predicates.map((p) => p.field))];
      if (setContract !== undefined) {
        await setContract(plan);
      }

      return {
        content: [
          {
            type: 'text',
            text: `Playtest contract recorded: ${plan.predicates.length} machine-checked assertion(s) over ${plan.steps.length} input step(s) on field(s) ${fields.join(', ')}. Because this genre has no bundled playbook, the boot-and-repair loop will gate your game on THIS contract. Build so every asserted field is exposed in window.__game.debug.snapshot() and responds exactly as declared, then proceed.`,
          },
        ],
        details: { predicates: plan.predicates.length, steps: plan.steps.length, fields },
      };
    },
  };
}
