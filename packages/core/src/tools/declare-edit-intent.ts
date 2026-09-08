/**
 * `declare_edit_intent` — the missing verification for an ITERATION.
 *
 * ─── The gap this closes ────────────────────────────────────────────────────
 *
 * Everything that gates a run today verifies the game AS A GAME: it boots, it
 * renders, its genre's input→state loop works, it makes noise. Nothing verifies
 * the thing the user actually asked for on THIS turn.
 *
 * That is not a theoretical hole. In one production session of 15 runs, 12 were
 * the user re-asking for something the agent had already reported as done, and
 * every one of those runs shipped `passed`, `repair=0`, `playbook=2/2`:
 *
 *   "The jump is way too high"        → passed
 *   "Still wayyy too high jump"       → passed
 *   "cut it down to 1/4"              → passed
 *   "jump does not work now"          → passed
 *   "disable auto run"                → passed
 *   "it still autoruns"               → passed
 *   "it still starts autorunning"     → passed
 *
 * The genre check kept passing because the game kept being a working runner.
 * Whether the jump got lower — the entire content of the request — was never a
 * question anyone asked. The agent edited, self-reported success from reading
 * its own diff, and shipped.
 *
 * ─── What this does instead ─────────────────────────────────────────────────
 *
 * On an iteration the agent must first say, in machine-checkable terms, what
 * would be OBSERVABLY different if the edit worked — then the same deterministic
 * `scorePlaytest` that grades the genre playbook grades that too, on the real
 * game, in a real browser, before the run can ship.
 *
 * Two properties make this honest rather than ceremonial:
 *
 *   1. It is declared BEFORE the edit (the workflow prompt requires it as the
 *      first call of an iteration), so it is a commitment about the change, not
 *      a description of whatever happened to come out.
 *   2. Its predicates are added to the genre floor, never substituted for it.
 *      An edit must leave the game working AND do what was asked.
 *
 * A failure here is repairable, and the repair message quotes the user's own
 * request — which is what turns "the model believes it complied" into "the
 * browser disagrees, here is the number it read".
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
        'Dotted snapshot path to read AFTER this input, e.g. "playerPos.y", "score", "speed". ' +
        'The game MUST expose it in window.__game.debug.snapshot() — if the value you are ' +
        'changing is not observable there, expose it as part of this edit.',
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
        'Compare against the PREVIOUS asserting check instead of the pre-input baseline. Default false.',
    }),
  ),
  note: Type.Optional(Type.String({ description: 'Human-readable intent for this check.' })),
});

const DeclareEditIntentParams = Type.Object({
  request: Type.String({
    minLength: 1,
    description:
      'One sentence restating what the user asked for THIS turn, in their terms (e.g. "make the jump about a quarter as high", "stop the player auto-running"). Quoted back in the failure message, so keep it faithful to what they said.',
  }),
  observable: Type.String({
    minLength: 1,
    description:
      'What a player would SEE differently if the edit worked. If you cannot name something observable, the request is a pure refactor — say so here and pass an empty checks array.',
  }),
  checks: Type.Array(CheckParams, {
    maxItems: 8,
    description:
      'Ordered input→state checks proving the change happened. At least one MUST carry ' +
      'assertField + assertOp unless the edit is genuinely unobservable (pure refactor, ' +
      'comment, asset swap). Prefer an ABSOLUTE bound (lessThan/greaterThan) over ' +
      '"changes" — "changes" passes even when the value moved the wrong way.',
  }),
});

export interface EditIntent {
  request: string;
  observable: string;
  /** Null when the agent declared the edit unobservable (no checks). */
  plan: GamePlaytestPlan | null;
}

interface DeclareEditIntentDetails {
  request: string;
  predicates: number;
  fields: string[];
  unobservable: boolean;
}

export type SetEditIntentFn = (intent: EditIntent) => void | Promise<void>;

const LITERAL_OPS = new Set(['greaterThan', 'lessThan', 'equals']);

export function makeDeclareEditIntentTool(
  setEditIntent: SetEditIntentFn | undefined,
): AgentTool<typeof DeclareEditIntentParams, DeclareEditIntentDetails> {
  return {
    name: 'declare_edit_intent',
    label: 'Declare edit intent',
    description:
      'FIRST call of every iteration on an existing game. State what the user asked for and how it ' +
      'will be OBSERVABLE, with input→state checks that prove it. The boot-and-repair loop runs your ' +
      'checks against the real game in a browser and will not let the run ship until they pass — in ' +
      'ADDITION to the genre floor, so the edit must both work and not break the game. This exists ' +
      'because "I made the change" is not evidence: a game keeps passing every generic check while ' +
      'completely ignoring the request, which is how a single "the jump is too high" turned into six ' +
      'rounds of the user repeating themselves. Prefer an absolute bound (lessThan/greaterThan) over ' +
      '"changes" — "changes" is satisfied by a value moving the WRONG way.',
    parameters: DeclareEditIntentParams,
    async execute(_toolCallId, params): Promise<AgentToolResult<DeclareEditIntentDetails>> {
      const { checks, request, observable } = params;

      // A declared-unobservable edit is legitimate (a comment, a rename, an
      // asset swap) but must be a deliberate statement, not an empty default.
      if (checks.length === 0) {
        if (setEditIntent !== undefined) {
          await setEditIntent({ request, observable, plan: null });
        }
        return {
          content: [
            {
              type: 'text',
              text:
                `Edit intent recorded as UNOBSERVABLE: "${request}". No play-check will gate this edit, ` +
                'so the genre floor alone applies. If the user would in fact see a difference, call this ' +
                'again with checks — an unverified behavioural edit is how a request gets silently ignored.',
            },
          ],
          details: { request, predicates: 0, fields: [], unobservable: true },
        };
      }

      const hasAssertion = checks.some((c) => c.assertField && c.assertOp);
      if (!hasAssertion) {
        throw new Error(
          'declare_edit_intent needs at least ONE check with assertField + assertOp — otherwise nothing ' +
            'about your edit is verified. Example, for "make the jump lower": ' +
            '{action:"key", key:"Space", holdFrames:6, assertField:"playerPos.y", assertOp:"greaterThan", assertValue:260} ' +
            '(with y growing downward). If the edit truly changes nothing observable, pass checks: [].',
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
        intent: request,
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
          'Those checks produced no machine-checkable predicate. Give at least one check a numeric ' +
            'assertField (e.g. "playerPos.y", "score", "speed") with an assertOp.',
        );
      }

      const fields = [...new Set(plan.predicates.map((p) => p.field))];
      if (setEditIntent !== undefined) {
        await setEditIntent({ request, observable, plan });
      }

      return {
        content: [
          {
            type: 'text',
            text:
              `Edit intent recorded: ${plan.predicates.length} assertion(s) over ${plan.steps.length} input step(s) ` +
              `on field(s) ${fields.join(', ')}. The run will be gated on these IN ADDITION to the genre floor, ` +
              `so make sure every asserted field is exposed in window.__game.debug.snapshot() before you finish. ` +
              `Now make the edit.`,
          },
        ],
        details: { request, predicates: plan.predicates.length, fields, unobservable: false },
      };
    },
  };
}
