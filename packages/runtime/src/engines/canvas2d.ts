/**
 * Engine Evolution v2 P8 — raw `<canvas>` 2D engine adapter.
 *
 * A first-class, vendor-free 2D target so the agent can HONESTLY build
 * bespoke/ambient 2D games (drag toys, fluid/particle fields, abstract
 * generative pieces) on the platform `CanvasRenderingContext2D` API instead
 * of declaring Phaser and faking a scene that the engine never actually runs.
 *
 * Unlike the three + phaser adapters, the bootstrap emits NO import-map and
 * references NO CDN: canvas2d needs no vendor ESM, so the iframe boots faster
 * and the locked CSP has no third-party origin to allow. The starter
 * index.html carries:
 *   - <base href="game-files://designs/{id}/"> (same privileged protocol)
 *   - the cross-engine `__game` global shim (postMessage tweak/score/controls
 *     bridge + the v2 debug.track/snapshot contract)
 *   - a <canvas id="game"> mount target the game draws to
 *   - a `<script type="module" src="src/main.js">` slot the agent fills in
 *
 * Validator checks the minimum that makes a canvas2d game real: a
 * requestAnimationFrame loop (per-frame update) AND a getContext('2d') call
 * (the canvas is actually drawn to) + the shared no-eval / anti-exfil rails.
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

/**
 * Bootstrap-template version. canvas2d pins no vendor library, so this tracks
 * the starter scaffold itself rather than a CDN package. It still flows
 * through `assertSemver` (via a `pinnedVersion` override) so the interface
 * contract — a strict-semver `defaultVersion` — holds across every engine.
 */
const CANVAS2D_DEFAULT_VERSION = '1.0.0';

function canvas2dBootstrap(opts: BootstrapOptions): string {
  // Mirror the three/phaser hardening: strict-semver the (template) version
  // and sanitize + attribute-escape the base before it reaches <base href>.
  // No URL interpolates the version for canvas2d, but validating it keeps the
  // adapter's option-handling identical to the vendor engines.
  assertSemver(opts.pinnedVersion ?? CANVAS2D_DEFAULT_VERSION);
  const baseHref = escapeAttribute(sanitizeGameBaseUrl(opts.gameBaseUrl));
  const globalSnippet = gameGlobalSetupSnippet({
    engine: 'canvas2d',
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
  canvas#game { display: block; width: 100%; height: 100%; }
</style>
${globalSnippet}
</head>
<body>
<canvas id="game"></canvas>
<script type="module" src="src/main.js"></script>
</body>
</html>`;
}

function canvas2dValidate(files: ReadonlyArray<InputFile>): ValidationResult {
  const issues: ValidationIssue[] = [];
  // canvas2d games author their draw loop in JS modules; the index.html only
  // carries the <canvas> mount target + the __game shim. Aggregate all
  // .js / .ts content the same way three + phaser do.
  const jsFiles = files.filter((f) => /\.[jt]sx?$/.test(f.path));
  const allJs = jsFiles.map((f) => f.content).join('\n\n');
  const indexHtml = files.find((f) => f.path === 'index.html');

  if (indexHtml === undefined) {
    issues.push({
      path: 'index.html',
      message: 'index.html is missing — the canonical entry point for canvas2d games.',
      severity: 'error',
    });
  } else if (!indexHtml.content.includes('<canvas')) {
    issues.push({
      path: 'index.html',
      message:
        'No <canvas> element found in index.html — a canvas2d game needs a canvas to draw to.',
      severity: 'warn',
    });
  }

  if (jsFiles.length === 0) {
    issues.push({
      path: 'src/',
      message:
        'No .js / .ts files found. canvas2d games author their draw loop in JavaScript modules.',
      severity: 'error',
    });
  } else {
    if (!/\brequestAnimationFrame\b/.test(allJs)) {
      issues.push({
        path: jsFiles[0]?.path ?? 'src/',
        message:
          'No requestAnimationFrame loop detected. canvas2d games need a per-frame update via `requestAnimationFrame(frame)`.',
        severity: 'error',
      });
    }
    if (!/\.getContext\s*\(\s*['"`]2d['"`]/.test(allJs)) {
      issues.push({
        path: jsFiles[0]?.path ?? 'src/',
        message:
          "No `getContext('2d')` call found. A canvas2d game must obtain a 2D drawing context (`canvas.getContext('2d')`) and draw to it.",
        severity: 'error',
      });
    }
    if (/\beval\s*\(|new\s+Function\s*\(/.test(allJs)) {
      issues.push({
        path: jsFiles[0]?.path ?? 'src/',
        message: 'eval / new Function detected. Forbidden — sandbox CSP would reject these anyway.',
        severity: 'error',
      });
    }
    // #41 (runtime half) — anti-exfil visibility. Surface a WARNING (never a
    // hard failure) when the code references the network, so the
    // connect-src 'self' expectation is visible at validate-time.
    const networkRefs = detectNetworkReferences(allJs);
    if (networkRefs.length > 0) {
      issues.push({
        path: jsFiles[0]?.path ?? 'src/',
        message: networkReferenceWarning(networkRefs),
        severity: 'warn',
      });
    }
  }

  if (issues.length === 0) return { ok: true };
  return { ok: false, issues };
}

export const canvas2dAdapter: GameEngineAdapter = {
  id: 'canvas2d',
  label: 'Canvas 2D',
  defaultVersion: CANVAS2D_DEFAULT_VERSION,
  canonicalEntry: 'index.html',
  fileExtensions: ['html', 'js', 'mjs', 'json', 'png', 'jpg', 'webp', 'wav', 'mp3', 'ogg'],
  bootstrap: canvas2dBootstrap,
  supportsLivePreview: () => true,
  validate: canvas2dValidate,
};
