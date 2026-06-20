/**
 * Brand identity — single source of truth for the product name, wordmark split,
 * and palette. The working codename was "Playforge"; the chosen brand is
 * **PlayerZero** (wordmark: "Player" in the base tone + "Zero" in the cyan
 * accent; mark: a dark rounded square with "P0", P base + 0 cyan).
 *
 * Imported by the web app (UI + social outro), API, and workers so the name and
 * colors can never drift across surfaces. The internal `@playforge/*` package
 * namespace is intentionally NOT renamed (that is a separate, larger refactor);
 * this module governs everything a user actually sees.
 */

export const BRAND_NAME = 'PlayerZero' as const;

/** Wordmark split: the leading part is rendered in the base tone, the trailing
 *  part in the cyan accent. ("Player" + "Zero" → Player·Zero) */
export const BRAND_WORDMARK = { head: 'Player', accent: 'Zero' } as const;

/** Logomark glyph shown inside the rounded-square tile: "P" (tone) + "0" (accent). */
export const BRAND_MARK = { head: 'P', accent: '0' } as const;

/** Brand color tokens (hex). Cyan is the primary accent; lime/amber/indigo are
 *  the social-outro metric accents. */
export const BRAND_COLORS = {
  base: '#0a0a0a',
  /** Slightly cooler base used by the brand board + logomark tile. */
  baseAlt: '#0a0a0c',
  surface: '#111111',
  text: '#f4f5f7',
  muted: 'rgba(244,245,247,0.55)',
  /** Primary brand accent. */
  cyan: '#46e6f0',
  lime: '#b6f24a',
  amber: '#ffb04d',
  indigo: '#7c83ff',
} as const;

/** Display + data font families used across brand surfaces. */
export const BRAND_FONTS = {
  display: "'Space Grotesk', system-ui, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, monospace",
} as const;
