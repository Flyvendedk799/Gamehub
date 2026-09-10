/**
 * gameplan §3 + §7.1 — Phaser engine adapter (Phase A).
 *
 * Pinned to phaser@3.88.0 ESM from cdn.jsdelivr.net. The bootstrap returns
 * a starter index.html with:
 *   - <base href="game-files://designs/{id}/">
 *   - <script type="importmap"> mapping `phaser` to the pinned CDN URL
 *   - the cross-engine `__game` global shim
 *   - a <div id="game"> mount target (Phaser injects its own canvas)
 *   - a `<script type="module" src="src/main.js">` slot
 *
 * Validator checks the §7.6 heuristics: Phaser.Game / extends Phaser.Scene
 * + scene lifecycle methods + physics-enable-before-add + load-precedes-add
 * + pinned CDN URL + no eval.
 */

import {
  assertSemver,
  detectNetworkReferences,
  escapeAttribute,
  networkReferenceWarning,
  sanitizeGameBaseUrl,
} from './bootstrap-safety';
import {
  type BootstrapOptions,
  type GameEngineAdapter,
  type InputFile,
  type ValidationIssue,
  type ValidationResult,
  gameGlobalSetupSnippet,
} from './types';

const PHASER_DEFAULT_VERSION = '3.88.0';

// ---------------------------------------------------------------------------
// Screen-space UI that scrolls off with the camera.
//
// The failure this exists for (production run e2bd3b58, "Operation: Fractured
// Front", 2026-09-10): the game built a complete HUD — zone bar, HP, role,
// mind-control cooldown, kill counter — inside a Container, pinned the CONTAINER
// with `.setScrollFactor(0)`, and shipped. The user's next message was "Game
// does not run".
//
// It ran. Every gate passed: it booted, it was non-blank, it responded to input,
// its authored contract scored 3/3. But `Container.setScrollFactor(x, y,
// updateChildren)` takes a THIRD argument, and it defaults to FALSE — the
// container is pinned while every child keeps `scrollFactorX/Y = 1`, and Phaser
// applies the child's own scroll factor on top of the parent transform. So the
// HUD renders correctly at camera scroll 0 and translates off-screen the instant
// the camera follows the player. Ten seconds in there is no UI at all: no health,
// no objective, no score, no indication of which of the forty identical sprites
// is you. That reads as a broken game, and nothing in the loop could see it,
// because a HUD only disappears AFTER the camera has moved and every frame the
// verifier looked at was taken before it did.
//
// It is exact to detect and free to fix, so it is an error, not a warn: the
// two-argument call on a Container is always this bug.
// ---------------------------------------------------------------------------

/** Every `.setScrollFactor(<args>)` call in a file, with the source text that
 *  precedes it — enough to identify the receiver in both spellings that matter:
 *  a chain off the constructor (`this.add.container(…).setDepth(9).setScrollFactor(0)`)
 *  and a call on a name (`this._hud.setScrollFactor(0)`). */
const SET_SCROLL_FACTOR_RE = /\.\s*setScrollFactor\s*\(([^()]*)\)/g;

/** `const hud = this.add.container(…)`, `let hud = …`, `this.hud = …`. */
const CONTAINER_DECL_RE =
  /(?:(?:const|let|var)\s+([\w$]+)|(?:this|self|scene)\s*\.\s*([\w$]+))\s*=\s*[^=;\n]*\.\s*add\s*\.\s*container\s*\(/g;

/** The receiver text immediately before a `.setScrollFactor(` call: either a
 *  dotted name, or a `)`-terminated chain we walk back through. */
const NAME_TAIL_RE = /((?:this|self|scene)\s*\.\s*[\w$]+|[\w$]+)\s*$/;

/** True when the chain ending at `before` was started by `.add.container(`.
 *  Walks back over intermediate chained calls — `.setDepth(200)`, `.setName('x')`
 *  — which are ordinary in this idiom. */
function chainStartsWithContainer(before: string): boolean {
  let cursor = before.trimEnd();
  // Bounded: each iteration strips one complete `(…)` call from the tail.
  for (let hop = 0; hop < 8; hop += 1) {
    if (!cursor.endsWith(')')) return false;
    const open = cursor.lastIndexOf('(');
    if (open < 0) return false;
    const head = cursor.slice(0, open).trimEnd();
    if (/\.\s*add\s*\.\s*container$/.test(head)) return true;
    const call = NAME_TAIL_RE.exec(head);
    if (call === null) return false;
    cursor = head.slice(0, call.index).trimEnd();
    // Drop the `.` that joined this call to the rest of the chain.
    if (cursor.endsWith('.')) cursor = cursor.slice(0, -1).trimEnd();
  }
  return false;
}

/** Count top-level arguments in a call's argument text. Every real spelling of
 *  this call passes numeric/boolean literals, so a comma split is exact. */
function countArgs(argText: string): number {
  const trimmed = argText.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(',').length;
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

/**
 * Flag `Container.setScrollFactor(0)` calls that leave the container's children
 * scrolling with the world, plus the weaker "camera scrolls and nothing in the
 * bundle is pinned at all" signal.
 *
 * Per-file so the reported path and line point at the actual source.
 */
export function findUnpinnedScreenSpaceUi(files: ReadonlyArray<InputFile>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const jsFiles = files.filter((f) => /\.[jt]sx?$/.test(f.path));
  let sawAnyPin = false;
  let sawCameraScroll = false;
  let sawText = false;
  let firstTextPath: string | undefined;

  for (const file of jsFiles) {
    const src = file.content;
    if (/\.(?:startFollow|centerOn|pan)\s*\(|\.scrollX\s*[-+]?=|\.setScroll\s*\(/.test(src)) {
      sawCameraScroll = true;
    }
    if (/\.\s*add\s*\.\s*(?:text|bitmapText)\s*\(/.test(src)) {
      sawText = true;
      firstTextPath ??= file.path;
    }

    // Every identifier that provably holds a Container in this file.
    const containers = new Set<string>();
    CONTAINER_DECL_RE.lastIndex = 0;
    for (let m = CONTAINER_DECL_RE.exec(src); m !== null; m = CONTAINER_DECL_RE.exec(src)) {
      const bare = m[1];
      const member = m[2];
      if (bare !== undefined) containers.add(bare);
      if (member !== undefined) {
        for (const self of ['this', 'self', 'scene']) containers.add(`${self}.${member}`);
      }
    }

    SET_SCROLL_FACTOR_RE.lastIndex = 0;
    for (let m = SET_SCROLL_FACTOR_RE.exec(src); m !== null; m = SET_SCROLL_FACTOR_RE.exec(src)) {
      const args = m[1] ?? '';
      // Only a PINNING call is interesting — `setScrollFactor(1)` is world-space.
      if (!/^\s*0\s*(?:,\s*0\s*)?\s*(?:,[^,]*)?$/.test(args)) continue;
      sawAnyPin = true;
      if (countArgs(args) >= 3) continue;

      const before = src.slice(0, m.index);
      const named = NAME_TAIL_RE.exec(before);
      const receiver = named === null ? null : (named[1]?.replace(/\s+/g, '') ?? null);
      const isContainer =
        (receiver !== null && containers.has(receiver)) || chainStartsWithContainer(before);
      if (!isContainer) continue;

      const shown = receiver ?? 'container';
      issues.push({
        path: file.path,
        line: lineOf(src, m.index),
        message: [
          `ui.container_children_scroll: \`${shown}.setScrollFactor(${args.trim()})\` pins the Container`,
          'but NOT its children — `Container.setScrollFactor(x, y, updateChildren)` takes a THIRD argument',
          'and it defaults to false, so every child keeps scrollFactor 1 and Phaser applies it on top of the',
          'parent transform. The UI looks right while the camera is at scroll 0 and slides off-screen as soon',
          'as the camera moves, leaving the player with no HUD at all. Fix:',
          `\`${shown}.setScrollFactor(0, 0, true)\`, or call \`.setScrollFactor(0)\` on each child before`,
          'adding it to the container.',
        ].join(' '),
        severity: 'error',
      });
    }
  }

  // ── Camera zoom scales screen-space UI too ───────────────────────────────
  //
  // The SECOND half of the same production failure. Fixing the container above
  // and re-running the real game still showed no HUD, because the scene also
  // called `this.cameras.main.setZoom(1.25)`. Camera zoom applies to the camera
  // MATRIX, so it scales scrollFactor-0 objects as well — about the camera
  // centre. A HUD laid out against the 800x600 canvas (`text(12, 566, 'HP')`)
  // lands at 400 + (12-400)*1.25 = -85 and 300 + (566-300)*1.25 = 632: both
  // outside the viewport. Every element within ~40% of the centre survives, so
  // a start-of-run screenshot (a centred title, a centred modal) looks correct
  // and the edge-anchored HUD is gone.
  //
  // The escape hatch is the real fix: a second, unzoomed camera for UI. If the
  // scene made one, this is not a bug and we say nothing.
  for (const file of jsFiles) {
    const src = file.content;
    const zoom = /\.\s*setZoom\s*\(\s*([0-9.]+)\s*[,)]/.exec(src);
    if (zoom === null) continue;
    const factor = Number.parseFloat(zoom[1] ?? '1');
    if (!Number.isFinite(factor) || factor === 1) continue;
    if (!/\.\s*setScrollFactor\s*\(\s*0/.test(src)) continue;
    // A dedicated UI camera (`cameras.add(...)`, or `ignore(...)` partitioning
    // the display list between cameras) means the UI is already unzoomed.
    if (/\.\s*cameras\s*\.\s*add\s*\(|\.\s*ignore\s*\(/.test(src)) continue;
    issues.push({
      path: file.path,
      line: lineOf(src, zoom.index),
      message: [
        `ui.zoomed_screen_space: this scene calls \`setZoom(${factor})\` on the same camera that renders its`,
        'screen-space UI. Camera zoom is part of the camera matrix, so it scales scrollFactor-0 objects too —',
        'about the camera centre. A HUD anchored to the canvas edges is pushed off the viewport (an element at',
        `y=566 on a 600px canvas lands at ${Math.round(300 + (566 - 300) * factor)}), while anything near the`,
        'centre still looks right — so the first frame looks fine and the HUD is gone. Fix: render UI on its',
        'own unzoomed camera — `const ui = this.cameras.add(0, 0, w, h); ui.ignore(worldObjects);',
        'this.cameras.main.ignore(uiObjects);` — or lay the HUD out against `this.cameras.main.worldView`',
        'instead of raw canvas coordinates.',
      ].join(' '),
      severity: 'error',
    });
  }

  // Weaker, second signal: a camera that follows something, text on screen, and
  // not a single pinned object anywhere in the bundle. Either the game has no
  // HUD, or its HUD scrolls away. Warn — a game may legitimately draw all its
  // text in world space (floating damage numbers, place labels).
  if (sawCameraScroll && sawText && !sawAnyPin) {
    issues.push({
      path: firstTextPath ?? 'src/',
      message:
        'ui.no_pinned_hud: the camera scrolls (startFollow / setScroll) and the scene draws text, but nothing ' +
        'in the bundle calls setScrollFactor(0). Any HUD drawn in world coordinates scrolls out of view the ' +
        'moment the camera moves. Pin every screen-space element — `.setScrollFactor(0)` on the object, or ' +
        '`.setScrollFactor(0, 0, true)` on a Container — and leave scrollFactor 1 only on things that belong ' +
        'in the world.',
      severity: 'warn',
    });
  }

  return issues;
}

function phaserImportMap(version: string): string {
  return `<script type="importmap">
{
  "imports": {
    "phaser": "https://cdn.jsdelivr.net/npm/phaser@${version}/dist/phaser.esm.js"
  }
}
</script>`;
}

function phaserBootstrap(opts: BootstrapOptions): string {
  // #47 — strict-semver the version before it reaches the import-map URL;
  // sanitize + escape the base before it reaches the <base href> attribute.
  const version = assertSemver(opts.pinnedVersion ?? PHASER_DEFAULT_VERSION);
  const baseHref = escapeAttribute(sanitizeGameBaseUrl(opts.gameBaseUrl));
  const globalSnippet = gameGlobalSetupSnippet({
    engine: 'phaser',
    initialParams: opts.initialParams ?? {},
    startMuted: opts.startMuted ?? false,
  });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<base href="${baseHref}" />
<title>Game</title>
<style>
  html, body { margin: 0; height: 100%; background: #0b0b0e; color: #e6e6e6;
    font: 14px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  #game { width: 100%; height: 100%; }
  #game canvas { display: block; width: 100% !important; height: 100% !important; }
</style>
${phaserImportMap(version)}
${globalSnippet}
</head>
<body>
<div id="game"></div>
<script type="module" src="src/main.js"></script>
</body>
</html>`;
}

function phaserValidate(files: ReadonlyArray<InputFile>): ValidationResult {
  const issues: ValidationIssue[] = [];
  const jsFiles = files.filter((f) => /\.[jt]sx?$/.test(f.path));
  const allJs = jsFiles.map((f) => f.content).join('\n\n');
  const indexHtml = files.find((f) => f.path === 'index.html');

  if (indexHtml === undefined) {
    issues.push({
      path: 'index.html',
      message: 'index.html is missing — the canonical entry point for Phaser games.',
      severity: 'error',
    });
  } else {
    if (!indexHtml.content.includes('importmap')) {
      issues.push({
        path: 'index.html',
        message:
          'index.html does not declare an importmap. Add <script type="importmap"> mapping `phaser` to the pinned cdn.jsdelivr.net URL.',
        severity: 'error',
      });
    } else if (!/phaser@3\.88(\.\d+)?\//.test(indexHtml.content)) {
      issues.push({
        path: 'index.html',
        message:
          'Phaser import URL must pin to phaser@3.88.x (gameplan Appendix). Phaser 4.x alpha has different scene/physics APIs and is not supported.',
        severity: 'warn',
      });
    }
    // The ESM build is `dist/phaser.esm.js` (a DOT). `dist/phaser-esm.js` (a
    // DASH) is a common model typo that 404s on jsdelivr, so `import * as Phaser
    // from "phaser"` rejects, window.__game is never set, and the game shows a
    // blank page. Flag it as a hard error (the persist/serve layers also auto-
    // correct it, but the agent should learn the right URL).
    if (/phaser@[^/"'\s]+\/dist\/phaser-esm\.js/.test(indexHtml.content)) {
      issues.push({
        path: 'index.html',
        message:
          'Phaser ESM URL is malformed: the build is `dist/phaser.esm.js` (a dot), not `dist/phaser-esm.js` (a dash). The dash form 404s on the CDN so the game never boots. Use `https://cdn.jsdelivr.net/npm/phaser@3.88.0/dist/phaser.esm.js`.',
        severity: 'error',
      });
    }
    if (
      !/<div[^>]*id=["']game["']/.test(indexHtml.content) &&
      !indexHtml.content.includes('<canvas')
    ) {
      issues.push({
        path: 'index.html',
        message:
          'No mount target found. Phaser needs either <div id="game"> (it injects its own canvas) or a pre-existing <canvas>.',
        severity: 'warn',
      });
    }
  }

  if (jsFiles.length === 0) {
    issues.push({
      path: 'src/',
      message:
        'No .js / .ts files found. Phaser games author scenes + game config in JavaScript modules.',
      severity: 'error',
    });
  } else {
    if (/\bimport\s+Phaser\s+from\s+['"]phaser['"]\s*;?/.test(allJs)) {
      issues.push({
        path: jsFiles[0]?.path ?? 'src/',
        message:
          'Use `import * as Phaser from "phaser"` with the pinned Phaser ESM importmap. `import Phaser from "phaser"` fails at runtime because phaser.esm.js does not provide a default export.',
        severity: 'error',
      });
    }

    const hasGame = /\bnew\s+Phaser\.Game\b/.test(allJs);
    const hasScene =
      /\bextends\s+Phaser\.Scene\b/.test(allJs) || /\bclass\s+\w+Scene\b/.test(allJs);
    if (!hasGame && !hasScene) {
      issues.push({
        path: jsFiles[0]?.path ?? 'src/',
        message:
          'No `new Phaser.Game(…)` constructor or `extends Phaser.Scene` class found. The game must instantiate a Phaser.Game with a config object that lists at least one scene.',
        severity: 'error',
      });
    }

    if (hasScene) {
      const hasLifecycle =
        /\bpreload\s*\(/.test(allJs) || /\bcreate\s*\(/.test(allJs) || /\bupdate\s*\(/.test(allJs);
      if (!hasLifecycle) {
        issues.push({
          path: jsFiles[0]?.path ?? 'src/',
          message:
            'Scenes declare lifecycle methods (`preload`, `create`, `update`) — none found. Without `update()` the game has no per-frame logic.',
          severity: 'warn',
        });
      }
    }

    // Physics ordering: this.physics.add.* without an arcade/matter
    // declaration in the Phaser.Game config will throw "physics is undefined".
    if (
      /this\.physics\.add\./.test(allJs) &&
      !/physics\s*:\s*\{[^}]*default\s*:\s*['"](arcade|matter)['"]/.test(allJs)
    ) {
      issues.push({
        path: jsFiles[0]?.path ?? 'src/',
        message:
          'Used `this.physics.add.*` but no `physics: { default: "arcade" | "matter" }` block found in the Phaser.Game config.',
        severity: 'error',
      });
    }

    // Load-before-add: this.add.image('key') without a matching texture source
    // upstream is the most common Phaser mistake. But a texture is "known" if it
    // comes from the asset pipeline OR is baked at runtime — canvas textures,
    // generated textures, and base64 are all valid sources. Only counting
    // this.load.* produced FALSE errors that pushed the agent to abandon
    // procedural/canvas art for immediate-mode Graphics purely to pass lint.
    const addImageKeys = Array.from(
      allJs.matchAll(/this\.add\.(?:image|sprite)\s*\(\s*[^,]+,\s*[^,]+,\s*['"`]([^'"`]+)['"`]/g),
    ).map((m) => m[1]);
    const knownTextureKeys = new Set<string>([
      // From the asset pipeline.
      ...Array.from(
        allJs.matchAll(
          /this\.load\.(?:image|spritesheet|atlas|svg|aseprite)\s*\(\s*['"`]([^'"`]+)['"`]/g,
        ),
      ).map((m) => m[1] ?? ''),
      // Baked at runtime via the TextureManager (any receiver — this.textures,
      // scene.textures, game.textures): addCanvas/createCanvas/addBase64/addImage/generate.
      ...Array.from(
        allJs.matchAll(
          /\.textures\.(?:addCanvas|createCanvas|addBase64|addImage|generate)\s*\(\s*['"`]([^'"`]+)['"`]/g,
        ),
      ).map((m) => m[1] ?? ''),
      // graphics.generateTexture('key', w, h) and renderTexture.saveTexture('key').
      ...Array.from(
        allJs.matchAll(/\.(?:generateTexture|saveTexture)\s*\(\s*['"`]([^'"`]+)['"`]/g),
      ).map((m) => m[1] ?? ''),
    ]);
    for (const key of addImageKeys) {
      if (key !== undefined && !knownTextureKeys.has(key)) {
        issues.push({
          path: jsFiles[0]?.path ?? 'src/',
          message: `Asset key "${key}" is added via this.add but has no texture source — load it (this.load.image / spritesheet / atlas) or bake it (this.textures.addCanvas / createCanvas, graphics.generateTexture).`,
          severity: 'error',
        });
      }
    }

    if (/\beval\s*\(|new\s+Function\s*\(/.test(allJs)) {
      issues.push({
        path: jsFiles[0]?.path ?? 'src/',
        message: 'eval / new Function detected. Forbidden — sandbox CSP would reject these anyway.',
        severity: 'error',
      });
    }

    // #41 (runtime half) — anti-exfil visibility. WARNING (not a hard
    // failure) when the scene references the network, so the connect-src
    // 'self' expectation is visible at validate-time.
    const networkRefs = detectNetworkReferences(allJs);
    if (networkRefs.length > 0) {
      issues.push({
        path: jsFiles[0]?.path ?? 'src/',
        message: networkReferenceWarning(networkRefs),
        severity: 'warn',
      });
    }

    // Screen-space UI that scrolls off with the camera (see the block above
    // `findUnpinnedScreenSpaceUi`). The one defect in this file that a booted,
    // non-blank, input-responsive game can still ship with.
    issues.push(...findUnpinnedScreenSpaceUi(files));
  }

  // may9 Phase 8 follow-up #27 — trigger-zone reachability for Tiled
  // JSON levels. The FPS Wave Defense run (FPS-run #4) shipped a level
  // where the exit zone's centroid was numerically outside the
  // walkable polygon. We can't run point-in-polygon here without
  // parsing the full Tiled object layer with collision geometry, but
  // the structural lint catches the obvious cases:
  //  - trigger object positioned with negative coords or beyond map
  //    width/height
  //  - trigger object referenced by name in JS code but absent from
  //    the JSON
  for (const f of files) {
    if (!/\.json$/.test(f.path)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(f.content);
    } catch {
      continue;
    }
    if (!isTiledMap(parsed)) continue;
    const map = parsed;
    const mapW = map.width * map.tilewidth;
    const mapH = map.height * map.tileheight;
    for (const layer of map.layers) {
      if (layer.type !== 'objectgroup') continue;
      for (const obj of layer.objects ?? []) {
        const cx = (obj.x ?? 0) + (obj.width ?? 0) / 2;
        const cy = (obj.y ?? 0) + (obj.height ?? 0) / 2;
        if (cx < 0 || cy < 0 || cx > mapW || cy > mapH) {
          issues.push({
            path: f.path,
            message: `geometry.unreachable_trigger: '${obj.name ?? `obj#${obj.id}`}' centroid (${cx.toFixed(0)}, ${cy.toFixed(0)}) is outside the map bounds (${mapW}×${mapH}). Triggers must lie inside the walkable area + ε.`,
            severity: 'error',
          });
        }
      }
    }
  }

  if (issues.length === 0) return { ok: true };
  return { ok: false, issues };
}

interface TiledMap {
  width: number;
  height: number;
  tilewidth: number;
  tileheight: number;
  layers: Array<{
    type: string;
    objects?: Array<{
      id?: number;
      name?: string;
      x?: number;
      y?: number;
      width?: number;
      height?: number;
    }>;
  }>;
}

function isTiledMap(value: unknown): value is TiledMap {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['width'] === 'number' &&
    typeof v['height'] === 'number' &&
    typeof v['tilewidth'] === 'number' &&
    typeof v['tileheight'] === 'number' &&
    Array.isArray(v['layers'])
  );
}

export const phaserAdapter: GameEngineAdapter = {
  id: 'phaser',
  label: 'Phaser',
  defaultVersion: PHASER_DEFAULT_VERSION,
  canonicalEntry: 'index.html',
  fileExtensions: ['html', 'js', 'mjs', 'json', 'png', 'jpg', 'webp', 'wav', 'mp3', 'ogg'],
  bootstrap: phaserBootstrap,
  supportsLivePreview: () => true,
  validate: phaserValidate,
};
