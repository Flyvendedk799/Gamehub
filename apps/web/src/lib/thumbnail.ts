/**
 * Phase 3.1 — gallery thumbnail helpers.
 *
 * Hub cards lead with the game's `thumbnailUrl`. When it's null we fall back to
 * a tasteful, deterministic gradient (seeded off the game's id so the same game
 * always gets the same swatch) instead of a flat grey box. These helpers are
 * pure so the fallback selection + URL resolution can be unit-tested.
 */

import { API_BASE } from './config';

/**
 * Resolve a stored thumbnail URL for use in an `<img src>`. Absolute URLs
 * (http/https/data) pass through; a server-relative path (e.g. `/v1/...`) is
 * prefixed with the API base. Returns `null` for a missing/blank value so the
 * caller renders the gradient fallback.
 */
export function resolveThumbnailUrl(url: string | null | undefined): string | null {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (trimmed.length === 0) return null;
  if (/^(https?:)?\/\//i.test(trimmed) || trimmed.startsWith('data:')) return trimmed;
  if (trimmed.startsWith('/')) return `${API_BASE}${trimmed}`;
  return trimmed;
}

/** Curated fallback stops: dark duotones tinted toward the PlayerZero accent
 *  hues (signal cyan, lime, amber, red) so an empty slot reads as a quiet
 *  surface, not a marketing gradient — per the identity board's "no gradient
 *  fills" rule these stay within the surface ramp's value range. */
const GRADIENTS: ReadonlyArray<readonly [string, string]> = [
  ['#101112', '#1c1f21'],
  ['#0e1b1d', '#14282b'],
  ['#131710', '#1d2614'],
  ['#1a150d', '#2a2012'],
  ['#1b100c', '#2a1712'],
  ['#0e1418', '#142028'],
  ['#121017', '#1c1826'],
  ['#101410', '#182018'],
];

/** Stable hash so a given seed always lands on the same gradient. */
function hashSeed(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) {
    h = (h * 31 + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/**
 * Pick a deterministic placeholder gradient for a game with no thumbnail.
 * Returns a `linear-gradient(...)` string usable as a CSS `background`.
 */
export function placeholderGradient(seed: string): string {
  const idx = GRADIENTS.length > 0 ? hashSeed(seed) % GRADIENTS.length : 0;
  const pair = GRADIENTS[idx] ?? GRADIENTS[0]!;
  return `linear-gradient(135deg, ${pair[0]} 0%, ${pair[1]} 100%)`;
}
