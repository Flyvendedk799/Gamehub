/**
 * Brand identity — single source of truth for the product name, wordmark split,
 * and palette. The working codename was "Playforge"; the chosen brand is
 * **PlayerZero** (wordmark: "PLAYER" in the base tone + "ZERO" in the cyan
 * accent, set in Archivo Expanded; mark: direction A "Slot Zero" — a hairline
 * cyan-framed square holding a lone "0", the empty slot you build from).
 *
 * Palette + type per the PlayerZero Identity board v1: a four-step dark surface
 * ramp separated by 1px hairlines, signal cyan as the ONLY interactive color
 * (rationed: one primary action per view), and amber/lime/red reserved for
 * build/pass/fail state. Radius is 2px, never more; no shadows or gradients.
 *
 * Imported by the web app (UI + social outro), API, and workers so the name and
 * colors can never drift across surfaces. The internal `@playforge/*` package
 * namespace is intentionally NOT renamed (that is a separate, larger refactor);
 * this module governs everything a user actually sees.
 */

export const BRAND_NAME = 'PlayerZero' as const;

/** One-line positioning, used for meta descriptions and the social outro. */
export const BRAND_TAGLINE = 'A production console for games' as const;

/** Wordmark split: the leading part is rendered in the base tone, the trailing
 *  part in the cyan accent. Presentation is uppercase ("PLAYER" + "ZERO"). */
export const BRAND_WORDMARK = { head: 'Player', accent: 'Zero' } as const;

/** Logomark — direction A "Slot Zero": a square hairline frame in signal cyan
 *  containing a single "0" in the base text tone. Empty by design; it is the
 *  favicon, the app-rail mark, and the social-outro stamp. */
export const BRAND_MARK = { glyph: '0' } as const;

/** Brand color tokens (hex), per the identity board. */
export const BRAND_COLORS = {
  /** Page backdrop behind everything. */
  base: '#0a0b0c',
  /** Darkest chrome — rails, headers, top bars. */
  chrome: '#0d0e10',
  /** GROUND — the default panel surface. */
  ground: '#101112',
  /** SURFACE — cards and inputs. */
  surface: '#16181a',
  /** RAISED — active/hover surfaces; top of the ramp. */
  raised: '#1c1f21',
  /** 1px hairline that separates everything. */
  hairline: '#26292c',
  /** Stronger border for secondary buttons/keys. */
  edge: '#35393c',
  /** Primary text. */
  text: '#f2f4f5',
  /** Secondary text (body copy on dark). */
  textSecondary: '#c8ccce',
  /** Muted text (supporting copy, inactive labels). */
  muted: '#8b9095',
  /** Faintest legible text (kickers, metadata). */
  faint: '#5b6165',
  /** SIGNAL — the only interactive color. */
  cyan: '#46e6f0',
  /** Signal hover state. */
  cyanBright: '#7ff0f8',
  /** Text tone on a signal-cyan fill. */
  onCyan: '#0d0e10',
  /** PASS — playable / success. */
  lime: '#b6f24a',
  /** LIVE / BUILDING — in-flight state. */
  amber: '#ffb04d',
  /** FAIL — build/runtime errors. */
  red: '#ff5d3b',
} as const;

/** Display + data font families used across brand surfaces. Archivo carries
 *  every human sentence (variable width axis: the display voice is Expanded
 *  ~118%); JetBrains Mono carries every number, ID, label, and log line. */
export const BRAND_FONTS = {
  display: "'Archivo', system-ui, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, monospace",
} as const;
