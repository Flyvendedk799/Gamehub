/**
 * Social-outro pure formatters — the display strings for the 10-second animated
 * "share card" (proof a game was built fast by AI). Kept DOM-free so the canvas
 * renderer (SocialOutroPreview) and the export pipeline can share one source of
 * truth and the formatting can be unit-tested in isolation.
 *
 * Two URL helpers exist on purpose:
 *   - `publicShareUrl` → a clean DISPLAY string (host + path, no protocol) for
 *     the card face.
 *   - `copyablePlayUrl` → the absolute URL for the "copy link" button.
 */

/** Format a millisecond runtime as `M:SS` (0 → "0:00", 137000 → "2:17"). */
export function formatRuntime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Compact token count: "950" (<1000), "428K" (428000), "1.3M" (1250000).
 * K at >=1000, M at >=1e6; one decimal for M with a trailing ".0" dropped.
 */
export function formatTokenCount(tokens: number): string {
  const n = Math.max(0, tokens);
  if (n >= 1e6) {
    const millions = Math.round(n / 1e5) / 10; // one decimal place
    const text = millions.toFixed(1).replace(/\.0$/, '');
    return `${text}M`;
  }
  if (n >= 1000) {
    return `${Math.round(n / 1000)}K`;
  }
  return String(Math.round(n));
}

/** Pluralized prompt-loop count: "1 prompt" / "3 prompts". */
export function formatPromptLoops(count: number): string {
  const n = Math.max(0, Math.round(count));
  return `${n} ${n === 1 ? 'prompt' : 'prompts'}`;
}

const ABSOLUTE_URL_RE = /^https?:\/\//i;

/** The web origin's host, when running in a browser; null on the server. */
function browserHost(): string | null {
  if (typeof window === 'undefined') return null;
  const host = window.location?.host;
  return host ? host : null;
}

/**
 * Display URL for the card face: a clean `host/path` string with NO protocol.
 * - `null` → `null` (caller omits the url chip; never ship a fake url).
 * - An absolute `http(s)://host/path` → `host/path` (protocol stripped).
 * - A path (e.g. `/v1/play/<slug>`) → `<host>/v1/play/<slug>` when a browser
 *   host is known, else just the path.
 */
export function publicShareUrl(pathOrUrl: string | null): string | null {
  if (pathOrUrl == null) return null;
  const trimmed = pathOrUrl.trim();
  if (trimmed.length === 0) return null;

  if (ABSOLUTE_URL_RE.test(trimmed)) {
    // Strip protocol, keep host + path (and any query/hash). Drop a trailing
    // slash for tidiness, but keep a bare "host/" → "host".
    const withoutProtocol = trimmed.replace(ABSOLUTE_URL_RE, '');
    return withoutProtocol.replace(/\/$/, '');
  }

  const path = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  const host = browserHost();
  return host ? `${host}${path}` : path;
}

/**
 * Absolute URL for the "copy link" button.
 * - `null` → `null`.
 * - Already-absolute `http(s)` → returned as-is.
 * - A path → prefixed with the browser origin when known, else returned as the
 *   path (the modal can fall back to a configured origin if needed).
 */
export function copyablePlayUrl(pathOrUrl: string | null): string | null {
  if (pathOrUrl == null) return null;
  const trimmed = pathOrUrl.trim();
  if (trimmed.length === 0) return null;
  if (ABSOLUTE_URL_RE.test(trimmed)) return trimmed;

  const path = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  if (typeof window !== 'undefined' && window.location?.origin) {
    return `${window.location.origin}${path}`;
  }
  return path;
}

/**
 * Filesystem-safe slug for an exported file name: lowercase, non-alphanumeric
 * runs collapsed to a single `-`, trimmed of leading/trailing `-`, capped at 40
 * chars, with a `game` fallback when nothing usable remains.
 */
export function safeFileSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : 'game';
}
