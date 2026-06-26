/**
 * add_controller_support — give the game gamepad/controller support.
 *
 * Auto-maps the controls the game already declares onto a standard controller
 * (the SAME heuristic the Controls panel's "Add controller support" button uses)
 * and BAKES a self-contained gamepad bridge into the game's HTML. The bridge
 * polls the Gamepad API and dispatches the synthetic keydown/keyup/mousedown the
 * game already listens for, so a controller works in the builder preview AND in
 * the published, shared game (which never receives the serve-time injection).
 */

import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import {
  type GamepadMappableAction,
  autoMapGamepad,
  bakeGamepadIntoHtml,
  buildBakedGamepadBindings,
  padLabel,
} from '@playforge/shared';
import { Type } from '@sinclair/typebox';
import { assertSafeToolPath } from './path-safety.js';
import type { TextEditorFsCallbacks } from './text-editor.js';

const AddControllerSupportParams = Type.Object({
  actions: Type.Array(
    Type.Object({
      id: Type.String({ description: "The control's id, exactly as passed to controls.define." }),
      keys: Type.Array(Type.String(), {
        description: 'The KeyboardEvent.code / mouse-button strings this action is bound to.',
      }),
      label: Type.Optional(Type.String()),
      pointer: Type.Optional(
        Type.String({
          description:
            "Set for a mouse-axis control ('look'/'aim'/'drag') — skipped for controller.",
        }),
      ),
    }),
    {
      description:
        'The controls the game declares — the SAME actions array you passed to ' +
        'window.__game.controls.define. View the game source first if you do not have them.',
    },
  ),
  htmlPath: Type.Optional(
    Type.String({ description: "The game's HTML document path. Defaults to index.html." }),
  ),
});

export interface AddControllerSupportDetails {
  htmlPath: string;
  mapped: Array<{ id: string; buttons: string[] }>;
}

export function makeAddControllerSupportTool(
  fs: TextEditorFsCallbacks,
): AgentTool<typeof AddControllerSupportParams, AddControllerSupportDetails> {
  return {
    name: 'add_controller_support',
    label: 'Add controller support',
    description:
      'Add gamepad/controller support to the game. Auto-maps the current ' +
      'keyboard/mouse controls onto a standard controller (movement → D-pad + ' +
      'left stick, primary actions → A/B/X/Y + shoulders, pause/restart → Start) ' +
      'and BAKES a self-contained gamepad bridge into the game HTML so a ' +
      'controller works in the builder AND in the published, shared game. Call ' +
      'this when the user asks for controller / gamepad / joystick support. Pass ' +
      'the same `actions` you declared via window.__game.controls.define.',
    parameters: AddControllerSupportParams,
    async execute(_id, params): Promise<AgentToolResult<AddControllerSupportDetails>> {
      const htmlPath = (params.htmlPath ?? 'index.html').replace(/^\/+/, '');
      assertSafeToolPath(htmlPath, 'add_controller_support');

      const actions = params.actions as GamepadMappableAction[];
      const padMap = autoMapGamepad(actions);
      const mapped = actions
        .map((a) => ({
          id: a.id,
          buttons: (padMap[a.id] ?? []).map((c) => padLabel(c) ?? c),
        }))
        .filter((m) => m.buttons.length > 0);

      if (mapped.length === 0) {
        throw new Error(
          'No mappable controls — every declared action is pointer-only or has no ' +
            'inputs, so there is nothing to put on a controller. Declare at least one ' +
            'key/button-bound action first.',
        );
      }

      const file = fs.view(htmlPath);
      if (!file) {
        throw new Error(
          `${htmlPath} not found. Pass htmlPath if the game's HTML document isn't index.html.`,
        );
      }

      const baked = buildBakedGamepadBindings(actions);
      const next = bakeGamepadIntoHtml(file.content, baked);
      await fs.create(htmlPath, next);

      const summary = mapped.map((m) => `  • ${m.id} → ${m.buttons.join(' / ')}`).join('\n');
      return {
        content: [
          {
            type: 'text',
            text: `Controller support baked into ${htmlPath}. Mapping:\n${summary}\n\nMovement uses the D-pad and the left stick. It is live in the builder preview and ships with the published game — no further code changes needed.`,
          },
        ],
        details: { htmlPath, mapped },
      };
    },
  };
}
