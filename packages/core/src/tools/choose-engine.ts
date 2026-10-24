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
  engine: Type.Union([Type.Literal('three'), Type.Literal('phaser'), Type.Literal('canvas2d')]),
  rationale: Type.String({
    description:
      'One sentence on WHY this engine fits the brief — referenced in the chat to ' +
      'help the user understand the auto-pick (e.g. "2D arcade — Phaser has the deepest training corpus").',
  }),
});

export type ChooseEngineEngine = 'three' | 'phaser' | 'canvas2d';

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
  requireProductionPlan = false,
): AgentTool<typeof ChooseEngineParams, ChooseEngineDetails> {
  return {
    name: 'choose_engine',
    label: 'Choose engine',
    description:
      'Pick the game engine for this run AFTER declare_game_spec. ' +
      'Match to the brief: 3D / WebGL / parallax / first-person → three; ' +
      '2D arcade / platformer / top-down / puzzle / runner / retro → phaser; ' +
      'New cloud games use three or phaser; canvas2d is only for maintaining an existing legacy canvas project. ' +
      'The host validates (genre, dimensions, perspective) against the engine via checkEngineFit; obvious ' +
      'misfits (e.g. fps + phaser, or 3d + phaser/canvas2d) are warned. The choice is persisted on the next snapshot.',
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

      if (requireProductionPlan && !spec?.productionPlan) {
        throw new Error('Declare the game spec with its productionPlan before choosing an engine.');
      }
      if (requireProductionPlan && engine === 'canvas2d') {
        throw new Error(
          'New cloud games use Phaser or Three.js. canvas2d is supported only for existing projects.',
        );
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
      // Skills are phaser/three modules; canvas2d is a bespoke raw-canvas runtime
      // with no engine-specific skill library, so it gets no recommendations.
      const recs =
        spec?.capabilities && engine !== 'canvas2d'
          ? recommendSkills(spec.capabilities, engine, spec.genre)
          : [];
      const recBlock = formatRecommendationsForPrompt(recs);
      const recSuffix = recBlock.length > 0 ? `\n\n${recBlock}` : '';
      // v3 P8 — canvas2d has NO genre playbook, so the ONLY way it earns a real
      // play-verdict (instead of shipping unverified) is an agent-authored
      // contract. Make that a hard directive at pin time.
      const canvas2dSuffix =
        engine === 'canvas2d'
          ? '\n\nREQUIRED for canvas2d: it has no genre playbook, so you MUST call declare_playtest_contract (2-6 input→state checks against window.__game.debug.snapshot()) and wire debug.track(...) — otherwise the game ships unverified. See the canvas2d engine guide.'
          : '';

      // Premium pivot — a complete, bootable PREMIUM starter has been written to
      // src/main.js (art direction + Title/Play/Over screens + juice + WebAudio sfx +
      // draw-the-subject + preserveDrawingBuffer). The agent must ADAPT it, not
      // recreate it, so the premium structure survives (guide-level premium only got
      // partial adoption — the scaffold must be edited, not re-derived).
      const starterSuffix = `\n\nA premium starter is already in the project. Read index.html, src/main.js and the modules it imports. Keep the tested engine, input, audio and feedback helpers; edit the scene and gameplay modules for this brief. The sample dodge loop is disposable: replace it whenever it is not the user's mechanic. Use the capability-based skill recommendations to compose the required systems. Preserve a clear start/restart flow where appropriate, but choose the visual direction and feedback from creativeBrief rather than inheriting the starter theme. Wire every module into the import graph and verify the exported game.\n\nDraw every named noun as ITSELF, not a circle: window.__game.art.draw(ctx, '<noun>', x, y, size, { fill }) is a zero-import silhouette library (fish, bird, coin, gem, heart, rocket, car, tree, star, person, … + synonyms like 'salmon'/'spaceship'/'monster'; any unknown noun becomes a distinctive labelled crest). canvas2d draws with it directly; phaser/three bake a texture via window.__game.art.sprite('<noun>', 96) → addCanvas / CanvasTexture (the starter shows the exact call).`;

      return {
        content: [
          {
            type: 'text',
            text: `${warningPrefix}Engine pinned: ${engine}.${rationaleSuffix}${starterSuffix}${recSuffix}${canvas2dSuffix}`,
          },
        ],
        details: { engine, rationale, fitVerdict },
      };
    },
  };
}
