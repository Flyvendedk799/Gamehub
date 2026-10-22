/**
 * Static check for DOM ids that code looks up but nothing defines.
 *
 * The seeded page shell ships `<canvas id="game">` and the engine does
 * `createStage('game')` -> `document.querySelector('#game')`. A run that edits index.html and
 * renames the canvas (live case: `id="gameCanvas"`) leaves the lookup returning null, and the
 * game dies at boot with "Cannot read properties of null (reading 'width')" — an error that
 * names neither file. This finds that class of break up front and says what to change.
 *
 * Conservative on purpose: only lookups made directly on `document` (or via `createStage`) are
 * checked, and an id counts as defined if it appears as an `id=` attribute or `.id =` assignment
 * ANYWHERE in the project (including inside JS template strings that build the DOM at runtime).
 */
import type { ProjectFile } from './unresolved-imports.js';

export interface MissingDomId {
  /** The file that does the lookup. */
  from: string;
  id: string;
  via: string;
}

const DEFINITIONS: RegExp[] = [
  /\bid\s*=\s*\\?["']([\w-]+)\\?["']/g,
  /\.id\s*=\s*["']([\w-]+)["']/g,
  /setAttribute\(\s*["']id["']\s*,\s*["']([\w-]+)["']/g,
];

const LOOKUPS: Array<{ via: string; re: RegExp }> = [
  {
    via: 'document.getElementById',
    re: /document\s*\.\s*getElementById\(\s*["']([\w-]+)["']\s*\)/g,
  },
  {
    via: 'document.querySelector',
    re: /document\s*\.\s*querySelector\(\s*["']#([\w-]+)["']\s*\)/g,
  },
  { via: 'createStage', re: /\bcreateStage\(\s*["']([\w-]+)["']\s*\)/g },
];

function stripJsComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

export function definedDomIds(files: ProjectFile[]): Set<string> {
  const ids = new Set<string>();
  for (const f of files) {
    for (const re of DEFINITIONS) {
      for (const m of f.content.matchAll(re)) if (m[1]) ids.add(m[1]);
    }
  }
  return ids;
}

export function findMissingDomIds(files: ProjectFile[]): MissingDomId[] {
  if (!files.some((f) => /(^|\/)index\.html?$/i.test(f.path))) return [];
  const defined = definedDomIds(files);
  const seen = new Set<string>();
  const missing: MissingDomId[] = [];
  for (const f of files) {
    if (!/\.(m?js|cjs)$/i.test(f.path)) continue;
    const src = stripJsComments(f.content);
    // `createStage()` with no argument defaults to the shell's canvas, 'game'.
    const lookups = [...LOOKUPS];
    for (const { via, re } of lookups) {
      for (const m of src.matchAll(re)) {
        const id = m[1];
        if (!id || defined.has(id)) continue;
        const key = `${f.path}#${id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        missing.push({ from: f.path, id, via });
      }
    }
  }
  return missing;
}

export function describeMissingDomId(m: MissingDomId, files: ProjectFile[]): string {
  const html = files.find((f) => /(^|\/)index\.html?$/i.test(f.path))?.content ?? '';
  const canvases = [...html.matchAll(/<canvas\b[^>]*>/gi)].map((c) => c[0]);
  const hint =
    canvases.length > 0
      ? ` index.html has ${canvases.slice(0, 2).join(' and ')} instead.`
      : ' index.html has no <canvas> at all.';
  return (
    `${m.from} looks up #${m.id} (${m.via}), but no element with id="${m.id}" exists anywhere in the project.${hint} ` +
    `Give the right element id="${m.id}" in index.html (keep the page's canvas as <canvas id="${m.id}">), or change the lookup. ` +
    `The lookup returns null and the game crashes at boot.`
  );
}

/**
 * Deterministic restore for the one case worth fixing without a model: the page has exactly one
 * <canvas> whose id was changed, nothing else refers to the new id, and the code wants `wanted`.
 * Returns the repaired html, or null when it should be left alone.
 */
export function restoreCanvasId(files: ProjectFile[], wanted: string): string | null {
  const page = files.find((f) => /(^|\/)index\.html?$/i.test(f.path));
  if (!page) return null;
  const canvases = [...page.content.matchAll(/<canvas\b[^>]*>/gi)];
  if (canvases.length !== 1) return null;
  const tag = canvases[0]?.[0];
  if (tag === undefined) return null;
  const existing = /\bid\s*=\s*["']([\w-]+)["']/i.exec(tag)?.[1];
  if (existing === wanted) return null;
  // The old id must not be looked up by any script (renaming would break that lookup). CSS
  // selectors in the page itself are fine - they are renamed along with the element.
  if (existing !== undefined) {
    const lookup = new RegExp(
      String.raw`getElementById\(\s*["']${existing}["']|querySelector\(\s*["']#${existing}["']`,
    );
    const usedByScript = files.some((f) => lookup.test(f.content));
    const usedElsewhere = files.some(
      (f) => f !== page && !/\.html?$/i.test(f.path) && f.content.includes(`#${existing}`),
    );
    if (usedByScript || usedElsewhere) return null;
  }
  const fixedTag =
    existing === undefined
      ? tag.replace(/<canvas\b/i, `<canvas id="${wanted}"`)
      : tag.replace(/\bid\s*=\s*["'][\w-]+["']/i, `id="${wanted}"`);
  let html = page.content.replace(tag, fixedTag);
  if (existing !== undefined) {
    html = html.split(`#${existing}`).join(`#${wanted}`);
  }
  return html;
}
