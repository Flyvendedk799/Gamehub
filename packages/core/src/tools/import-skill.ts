/**
 * Engine Evolution v2 — Phase 1: `import_skill`.
 *
 * The dominant signal across 19 instrumented runs was `usesSkillFns=0` — the
 * agent OPENS a vetted skill via `view_game_feel` (which returns the module as a
 * text block) and then hand-rewrites its own version, paying read-tokens AND
 * re-derivation-tokens AND shipping fresh bugs (e.g. a platformer re-derived
 * save-state as raw localStorage). The skills are already real ES modules with
 * named exports; the only thing missing was a way to put one ON DISK and IMPORT
 * it. This tool does exactly that: it writes the vetted module into the project
 * (`src/engine/<skill>.js`) and returns the import line + public API — NOT the
 * full source — so the agent imports and CALLS the tested code instead of
 * retyping it.
 */

import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
import { GAME_SKILLS } from '../game-skills/index.js';
import type { TextEditorFsCallbacks } from './text-editor.js';

const ImportSkillParams = Type.Object({
  name: Type.String({
    description:
      'The skill to import, e.g. "phaser/wave-spawner.js" or "three/enemy-ai.jsx" — the same name list_game_feel / the choose_engine recommendation shows.',
  }),
});

export interface ImportSkillDetails {
  /** The skill name requested. */
  name: string;
  /** Where the module was written in the project FS. */
  path: string;
  /** The exported function names the agent can call. */
  exports: string[];
  /** True when the file already existed (no overwrite). */
  alreadyPresent: boolean;
}

/** Pull `export function NAME(` identifiers out of a skill module's source. */
function parseExports(source: string): string[] {
  const names: string[] = [];
  const re = /export\s+function\s+([A-Za-z_$][\w$]*)/g;
  let m: RegExpExecArray | null = re.exec(source);
  while (m !== null) {
    if (m[1]) names.push(m[1]);
    m = re.exec(source);
  }
  return names;
}

/** Pull the trailing `// Usage:` comment block so the agent sees HOW to wire the
 *  module without re-reading the implementation. */
function parseUsageBlock(source: string): string {
  const idx = source.search(/\n\/\/\s*Usage:/i);
  if (idx === -1) return '';
  return source
    .slice(idx)
    .split('\n')
    .filter((l) => l.trim().startsWith('//'))
    .map((l) => l.replace(/^\s*\/\/ ?/, ''))
    .join('\n')
    .trim();
}

/** `phaser/wave-spawner.js` / `three/enemy-ai.jsx` → `src/engine/wave-spawner.js`.
 *  Extension normalised to `.js` (the `.jsx` skills are plain JS by convention,
 *  and a browser ESM import needs `.js`). */
function canonicalImportPath(name: string): string {
  const base = (name.split('/').pop() ?? name).replace(/\.jsx$/i, '.js');
  return `src/engine/${base}`;
}

/** import_skill only reads + writes whole files, so it needs just this slice of
 *  the editor FS — keeps it trivially mockable + decoupled from edit ops. */
type ImportSkillFs = Pick<TextEditorFsCallbacks, 'view' | 'create'>;

export function makeImportSkillTool(
  fs: ImportSkillFs,
): AgentTool<typeof ImportSkillParams, ImportSkillDetails> {
  const map = new Map(GAME_SKILLS.map((e) => [e.name, e] as const));
  return {
    name: 'import_skill',
    label: 'Import skill module',
    description:
      'Write a vetted game-skill module into the project and get back the import line + its API, so you IMPORT and CALL the tested code instead of retyping it. ' +
      'Prefer this over view_game_feel for the capability systems recommended at choose_engine (enemy-ai, wave-spawner, level-orchestrator, save-state, dialog-flow, economy-system, procedural-gen, rhythm-clock, mobile-controls): ' +
      'import_skill({ name: "phaser/wave-spawner.js" }) writes src/engine/wave-spawner.js, then you `import { createWaveSystem } from "./engine/wave-spawner.js"` and call it. ' +
      'Re-deriving these systems by hand is the #1 source of flat, buggy, over-long builds. (view_game_feel is still right for the small inline FEEL snippets like screen-shake.)',
    parameters: ImportSkillParams,
    async execute(_id, params): Promise<AgentToolResult<ImportSkillDetails>> {
      const entry = map.get(params.name);
      if (entry === undefined) {
        const valid = Array.from(map.keys()).join(', ');
        throw new Error(`Unknown skill "${params.name}". Available: ${valid}`);
      }
      const path = canonicalImportPath(entry.name);
      const exports = parseExports(entry.source);
      const usage = parseUsageBlock(entry.source);
      const existing = fs.view(path);
      const alreadyPresent = existing !== null;
      if (!alreadyPresent) {
        await fs.create(path, entry.source);
      }
      // The file lives at src/engine/<base>.js; the entry (src/main.js) imports it
      // as './engine/<base>.js'.
      const importFrom = `./engine/${path.split('/').pop()}`;
      const importLine =
        exports.length > 0
          ? `import { ${exports.join(', ')} } from '${importFrom}';`
          : `import '${importFrom}';`;
      const verb = alreadyPresent ? 'already present' : 'written';
      const text = `Skill module ${verb} at ${path}. Add this import to your entry file and CALL the exports — do NOT reimplement them:\n  ${importLine}\n${usage ? `\nHow to wire it:\n${usage}\n` : ''}\nThe module is vetted + tested; call its functions directly.`;
      return {
        content: [{ type: 'text', text }],
        details: { name: entry.name, path, exports, alreadyPresent },
      };
    },
  };
}
