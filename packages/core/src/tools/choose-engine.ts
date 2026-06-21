/**
 * gameplan §A5 + may9 Phase 4 — `choose_engine` agent tool.
 *
 * The agent emits `{ engine, rationale }` after `declare_game_spec`. The
 * host wires a `setEngine` callback that captures the choice into a
 * per-run mutable; on the next snapshot, the host writes
 * `design_snapshots.engine` + `engine_version` from that mutable.
 *
 * may9 Phase 4 — when the host also wires `getSpec`, this tool calls
 * `checkEngineFit(spec, engine)` and:
 *   - returns success unchanged when the verdict is `ok`
 *   - returns success WITH a warning prefix in the result text when the
 *     verdict is `warn` (the run continues; the agent saw the warning)
 *   - returns an error result on `reject` and DOES NOT call setEngine
 *     so the agent must pick a different engine before proceeding
 *
 * No-op when the host doesn't pass `setEngine` (design-mode path) — the
 * tool still returns a confirmation so the agent loop terminates cleanly,
 * but the choice goes nowhere. In practice this branch never fires
 * because `agent.ts` only registers the tool when game-mode is active.
 */

import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { type GameSpec, checkEngineFit } from '@playforge/shared';
import { Type } from '@sinclair/typebox';
import { formatRecommendationsForPrompt, recommendSkills } from '../recommend-skills.js';

const ChooseEngineParams = Type.Object({
  engine: Type.Union([Type.Literal('three'), Type.Literal('phaser')]),
  rationale: Type.String({
    description:
      'One sentence on WHY this engine fits the brief — referenced in the chat to ' +
      'help the user understand the auto-pick (e.g. "2D arcade — Phaser has the deepest training corpus").',
  }),
});

export type ChooseEngineEngine = 'three' | 'phaser';

export interface ChooseEngineDetails {
  engine: ChooseEngineEngine;
  rationale: string;
  fitVerdict?: 'ok' | 'warn' | 'reject';
}

export type ChooseEngineFn = (
  engine: ChooseEngineEngine,
  rationale: string,
) => void | Promise<void>;

/** Optional spec-getter so the tool can run checkEngineFit before
 *  committing the engine choice. When undefined the gate is dormant
 *  and the tool behaves like the legacy version. */
export type GetGameSpecForFitFn = () => GameSpec | undefined | Promise<GameSpec | undefined>;

export function makeChooseEngineTool(
  setEngine: ChooseEngineFn | undefined,
  getSpec?: GetGameSpecForFitFn,
): AgentTool<typeof ChooseEngineParams, ChooseEngineDetails> {
  return {
    name: 'choose_engine',
    label: 'Choose engine',
    description:
      'Pick the game engine for this run AFTER declare_game_spec. ' +
      'Match to the brief: 3D / WebGL / parallax / first-person → three; ' +
      '2D arcade / platformer / top-down / puzzle / runner / retro → phaser. ' +
      'The host validates (genre, dimensions, perspective) against the engine via checkEngineFit; obvious ' +
      'misfits (e.g. fps + phaser, or 3d + phaser) are warned. The choice is persisted on the next snapshot.',
    parameters: ChooseEngineParams,
    async execute(_toolCallId, params): Promise<AgentToolResult<ChooseEngineDetails>> {
      const engine = params.engine;
      const rationale = params.rationale.trim();

      // Phase 4 — fit gate. Skip when getSpec is undefined (legacy
      // path) or when no spec has been declared yet (vitest path).
      let fitVerdict: 'ok' | 'warn' | 'reject' = 'ok';
      let fitReason = '';
      let spec: GameSpec | undefined;
      if (getSpec !== undefined) {
        spec = await getSpec();
        if (spec !== undefined) {
          const fit = checkEngineFit(spec, engine);
          fitVerdict = fit.verdict;
          fitReason = fit.reason;
        }
      }

      if (fitVerdict === 'reject') {
        return {
          content: [
            {
              type: 'text',
              text: `ERROR: engine '${engine}' rejected by checkEngineFit. ${fitReason} Pick a different engine and call choose_engine again.`,
            },
          ],
          details: { engine, rationale, fitVerdict },
        };
      }

      if (setEngine !== undefined) {
        await setEngine(engine, rationale);
      }

      const rationaleSuffix = rationale.length > 0 ? ` (${rationale})` : '';
      const warningPrefix =
        fitVerdict === 'warn'
          ? `WARNING from checkEngineFit: ${fitReason} Proceeding anyway. `
          : '';

      // Phase 3 — push-model skill recommendation. From the declared capabilities
      // + the chosen engine, surface the vetted skills that implement this game's
      // systems so the agent reviews them with view_game_feel BEFORE hand-rolling
      // enemy AI / waves / progression / dialogue from scratch (the re-derivation
      // gap the probe runs exposed).
      const recs = spec?.capabilities ? recommendSkills(spec.capabilities, engine, spec.genre) : [];
      const recBlock = formatRecommendationsForPrompt(recs);
      const recSuffix = recBlock.length > 0 ? `\n\n${recBlock}` : '';

      return {
        content: [
          {
            type: 'text',
            text: `${warningPrefix}Engine pinned: ${engine}.${rationaleSuffix}${recSuffix}`,
          },
        ],
        details: { engine, rationale, fitVerdict },
      };
    },
  };
}
