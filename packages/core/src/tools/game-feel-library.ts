/**
 * Game-feel library tools — surface the bundled `game-skills/*` registry to
 * the agent as discoverable tools.
 *
 * Why this exists: the game-skills snippets ship in the bundle but were DEAD
 * — zero references anywhere, so the agent never saw them and re-derived game
 * feel ("juice") from scratch on every run, producing flat games. The static
 * workflow prompt could only afford ~2 prose bullets about juice. Adding
 * `list_game_feel` makes the JUICE/FEEL catalogue (screen-shake, hitstop,
 * particle burst, squash & stretch, score-pop, screen-flash, camera-kick,
 * knockback) plus the pre-existing engine scaffolding discoverable, so the
 * model loads the matching primitive before wiring impact feedback.
 *
 * Two tools (register only in game mode):
 *   - `list_game_feel({ engine?, category? })` — name + `whenToUse` hint +
 *      engine + category + size for each snippet, filterable by engine.
 *   - `view_game_feel({ name })` — full source of one snippet.
 *
 * No fs / state / I/O — pure registry lookups.
 * The snippet source is then adapted by the model into its
 * `text_editor.create(...)` / `str_replace(...)` calls.
 */

import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
import { GAME_SKILLS, type GameEngine, type GameSkillCategory } from '../game-skills/index.js';

/** Parse the leading `// when_to_use: ...` block (one or more contiguous
 *  comment lines) out of a game-skill file. Same convention as the design
 *  skills, but the game snippets are plain ES modules (`.js` / `.jsx`) whose
 *  first lines are `//` comments. Returns the joined hint or a fallback. */
function parseWhenToUse(src: string): string {
  const lines = src.split('\n');
  let startIdx = -1;
  for (let i = 0; i < Math.min(lines.length, 10); i += 1) {
    if (/^\s*\/\/\s*when_to_use\s*:/i.test(lines[i] ?? '')) {
      startIdx = i;
      break;
    }
  }
  if (startIdx === -1) return 'No when_to_use hint declared in this skill file.';
  const out: string[] = [];
  for (let i = startIdx; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (!line.startsWith('//')) break;
    const stripped = line.replace(/^\s*\/\/\s?/, '').replace(/^when_to_use\s*:\s*/i, '');
    out.push(stripped);
  }
  return out.join(' ').trim();
}

const EngineFilter = Type.Union([Type.Literal('phaser'), Type.Literal('three')]);
const CategoryFilter = Type.Union([Type.Literal('feel'), Type.Literal('engine')]);

const ListGameFeelParams = Type.Object({
  engine: Type.Optional(EngineFilter),
  category: Type.Optional(CategoryFilter),
});

export interface GameFeelEntry {
  name: string;
  engine: GameEngine;
  category: GameSkillCategory;
  whenToUse: string;
  sizeBytes: number;
}

export interface ListGameFeelDetails {
  skills: GameFeelEntry[];
}

export function makeListGameFeelTool(): AgentTool<typeof ListGameFeelParams, ListGameFeelDetails> {
  return {
    name: 'list_game_feel',
    label: 'List game-feel library',
    description:
      'Return the catalogue of JUICE/FEEL primitives + engine scaffolding for game builds. ' +
      'Feel primitives (category "feel") are the anti-slop differentiator: screen-shake, hitstop/freeze-frame, ' +
      'particle-burst, squash-&-stretch, score-pop/floating-text, screen-flash, camera-kick, knockback — ' +
      'copy-paste-grade, framework-correct for both Phaser 3 and Three.js. ' +
      'Each entry has a name, the `engine` it targets, a `category`, a `whenToUse` hint, and a byte size. ' +
      'Filter by `{ engine }` (your chosen engine) and optionally `{ category: "feel" }`. ' +
      'Call this during the polish step (workflow step 6) BEFORE wiring impact feedback, then ' +
      '`view_game_feel({ name })` the matching primitive. Skipping this means generated games feel flat.',
    parameters: ListGameFeelParams,
    async execute(_id, params): Promise<AgentToolResult<ListGameFeelDetails>> {
      const skills: GameFeelEntry[] = [];
      for (const entry of GAME_SKILLS) {
        if (params.engine !== undefined && entry.engine !== params.engine) continue;
        if (params.category !== undefined && entry.category !== params.category) continue;
        skills.push({
          name: entry.name,
          engine: entry.engine,
          category: entry.category,
          whenToUse: parseWhenToUse(entry.source),
          sizeBytes: entry.source.length,
        });
      }
      const text = skills
        .map((s) => `- ${s.name} [${s.engine}/${s.category}] (${s.sizeBytes}b): ${s.whenToUse}`)
        .join('\n');
      return {
        content: [{ type: 'text', text: `Game-feel library:\n${text}` }],
        details: { skills },
      };
    },
  };
}

const ViewGameFeelParams = Type.Object({
  name: Type.String(),
});

export interface ViewGameFeelDetails {
  name: string;
  engine: GameEngine;
  category: GameSkillCategory;
  source: string;
}

export function makeViewGameFeelTool(): AgentTool<typeof ViewGameFeelParams, ViewGameFeelDetails> {
  const map = new Map(GAME_SKILLS.map((e) => [e.name, e] as const));
  return {
    name: 'view_game_feel',
    label: 'View game-feel snippet',
    description:
      'Return the full source of one game-feel / scaffolding snippet (e.g. "phaser/screen-shake.js", ' +
      '"three/hitstop.jsx"). Call after `list_game_feel` to load the matching primitive. ' +
      'Adapt it to your scene — wire the helper into your hit / score / death handlers (e.g. screenShake + ' +
      'hitstop + particleBurst on an enemy hit) so the game has impact feedback. Use it as the starting ' +
      'structure for your `text_editor` call; do not paste verbatim if it needs adapting to your bindings.',
    parameters: ViewGameFeelParams,
    async execute(_id, params): Promise<AgentToolResult<ViewGameFeelDetails>> {
      const entry = map.get(params.name);
      if (entry === undefined) {
        const valid = Array.from(map.keys()).join(', ');
        throw new Error(`Unknown game-feel snippet "${params.name}". Available: ${valid}`);
      }
      return {
        content: [{ type: 'text', text: entry.source }],
        details: {
          name: entry.name,
          engine: entry.engine,
          category: entry.category,
          source: entry.source,
        },
      };
    },
  };
}
