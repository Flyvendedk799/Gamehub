/**
 * Keeps the page shell intact once the host has drafted the game.
 *
 * After a host draft the game already runs against the starter's `index.html`: the engine
 * importmap, the module script tags, and `<canvas id="game">` that `createStage('game')` looks up.
 * The model was told not to rewrite it and did anyway. Run a985c47a recreated `index.html` from
 * scratch, renamed the canvas to `game-canvas`, and the game died at boot with "Cannot read
 * properties of null (reading 'width')", an error that names neither file. The verifier then
 * said exactly what was wrong, twice, and the model spent the rest of its budget looking for a
 * file that does not exist. A note in the prompt did not stop it, so this is enforced in the tool:
 *
 *   1. Once armed (the host draft has landed), a whole-file `create` over an existing
 *      `index.html` is refused with the reason and the alternative.
 *   2. After ANY write to `index.html`, a canvas whose id no longer matches what the code looks
 *      up is put back, and the result says so. This is the same deterministic repair that runs
 *      at ship time, moved to the moment of the edit so the model never has to diagnose it.
 */
import { findMissingDomIds, restoreCanvasId } from './dom-ids.js';

const INDEX_RE = /(^|\/)index\.html?$/i;

export interface PageShellGuard {
  /** Call once the host draft has been written. Until then nothing is refused. */
  arm(): void;
  isArmed(): boolean;
  /** Refusal text for a whole-file create over an existing page, or null to allow it. */
  checkCreate(path: string, existing: string | null): string | null;
  /** After a write to the page, restore a renamed canvas id. Returns a notice, or ''. */
  repairCanvasId(
    path: string,
    fs: {
      textFiles?(): Array<{ path: string; content: string }>;
      create(path: string, content: string): Promise<{ path: string }> | { path: string };
    },
  ): Promise<string>;
}

export function createPageShellGuard(): PageShellGuard {
  let armed = false;
  return {
    arm() {
      armed = true;
    },
    isArmed() {
      return armed;
    },
    checkCreate(path, existing) {
      if (!armed || existing === null || !INDEX_RE.test(path)) return null;
      return `Refusing to recreate \`${path}\`: the host already wrote this game against the page shell, and a from-scratch page is how the canvas id, the engine importmap and the module script tags get lost. Change the page with \`str_replace\` or \`patch\`, and keep \`<canvas id="game">\`, the importmap and the \`<script type="module" src=...>\` tags exactly as they are. The game's name, look and rules belong in \`src/\`, not in a new page.`;
    },
    async repairCanvasId(path, fs) {
      if (!INDEX_RE.test(path) || fs.textFiles === undefined) return '';
      let files = fs.textFiles();
      const restored: string[] = [];
      for (const id of new Set(
        findMissingDomIds(files)
          .filter((m) => m.via === 'createStage')
          .map((m) => m.id),
      )) {
        const fixed = restoreCanvasId(files, id);
        if (fixed === null) continue;
        const page = files.find((f) => INDEX_RE.test(f.path));
        if (page === undefined) continue;
        await fs.create(page.path, fixed);
        files = fs.textFiles();
        restored.push(id);
      }
      if (restored.length === 0) return '';
      return `\n\nNote: the engine looks the canvas up as #${restored[0]}, so I restored id="${restored[0]}" on your <canvas>. Keep that id; renaming it makes the game die at boot.`;
    },
  };
}
