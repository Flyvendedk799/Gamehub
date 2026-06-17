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

/** Curated dark-friendly gradient stops, chosen to read well on `#0a0a0a`. */
const GRADIENTS: ReadonlyArray<readonly [string, string]> = [
  ['#6366f1', '#8b5cf6'],
  ['#0ea5e9', '#6366f1'],
  ['#ec4899', '#8b5cf6'],
  ['#f59e0b', '#ef4444'],
  ['#10b981', '#0ea5e9'],
  ['#8b5cf6', '#ec4899'],
  ['#14b8a6', '#6366f1'],
  ['#ef4444', '#f59e0b'],
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
