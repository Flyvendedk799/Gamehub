/**
 * engine-cdn — deterministic correction of near-miss engine CDN URLs the model
 * sometimes emits in generated game HTML.
 *
 * The canonical Phaser ESM build on jsdelivr is `dist/phaser.esm.js` (a DOT).
 * Smaller models occasionally write `dist/phaser-esm.js` (a DASH), which 404s on
 * jsdelivr — so `import * as Phaser from 'phaser'` rejects, `window.__game`
 * never gets assigned, and the preview renders a blank page. The engine prompt +
 * runtime adapter both pin the correct URL, but prose alone doesn't reliably
 * stop the typo, so we fix it deterministically wherever generated HTML is
 * stored (persist) or served (preview).
 *
 * Surgical by design: only the filename of a pinned `cdn.jsdelivr.net` Phaser
 * URL is rewritten, preserving the pinned version. Idempotent — a correct URL is
 * left untouched.
 */

/** Canonical Phaser ESM filename on jsdelivr (`/dist/<this>`). */
export const PHASER_ESM_FILENAME = 'phaser.esm.js';

const PHASER_DASH_ESM = /(cdn\.jsdelivr\.net\/npm\/phaser@[^/"'\s]+\/dist\/)phaser-esm\.js/g;

/**
 * Return `html` with any malformed pinned Phaser ESM URL corrected. Safe to run
 * on any string (non-HTML or already-correct input is returned unchanged).
 */
export function normalizeEngineCdnUrls(html: string): string {
  return html.replace(PHASER_DASH_ESM, `$1${PHASER_ESM_FILENAME}`);
}

/** True when the content carries a known-broken engine CDN URL. */
export function hasBrokenEngineCdnUrl(html: string): boolean {
  PHASER_DASH_ESM.lastIndex = 0;
  return PHASER_DASH_ESM.test(html);
}
