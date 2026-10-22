/**
 * Static check for calls to `window.__game.controls` members that do not exist.
 *
 * The page shell's controls runtime has a tiny, fixed API: `define`, `isDown`, `on`, `rebind`
 * (and the `manifest` it publishes). A model that has not read it tends to invent the obvious
 * name — a live build shipped `window.__game.controls.active('right')` and died on the first
 * keypress with "controls.active is not a function". The correct call exists; this says so up
 * front instead of after the crash.
 */
import type { ProjectFile } from './unresolved-imports.js';

export const CONTROLS_API = ['define', 'isDown', 'on', 'rebind', 'manifest'] as const;
const KNOWN = new Set<string>(CONTROLS_API);

export interface UnknownControlsCall {
  from: string;
  member: string;
}

function stripJsComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

export function findUnknownControlsCalls(files: ProjectFile[]): UnknownControlsCall[] {
  const found: UnknownControlsCall[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    // index.html is the host's shell and defines the API; only check the game's own code.
    if (!/\.(m?js|cjs)$/i.test(f.path)) continue;
    const src = stripJsComments(f.content);
    for (const m of src.matchAll(
      /window\s*\.\s*__game\s*\.\s*controls\s*\.\s*([A-Za-z_$][\w$]*)/g,
    )) {
      const member = m[1];
      if (!member || KNOWN.has(member)) continue;
      const key = `${f.path}#${member}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ from: f.path, member });
    }
  }
  return found;
}

export function describeUnknownControlsCall(c: UnknownControlsCall): string {
  return `${c.from} uses window.__game.controls.${c.member}, which does not exist and throws "is not a function" the first time it runs. The controls runtime has ONLY: define({ actions: [{ id, label, keys }] }) once at startup, isDown('actionId') -> true while the action's key is held, on('actionId', fn) -> fn() fires when it is pressed, and rebind(). Read held input with window.__game.controls.isDown('<actionId>').`;
}
