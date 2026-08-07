/**
 * Canonical public origin of the web app — the single source of truth for SEO
 * surfaces (metadataBase, canonical URLs, sitemap, robots, JSON-LD, OG images).
 *
 * Set NEXT_PUBLIC_SITE_URL to the deployed origin (e.g. https://playerzero.example)
 * in production; the localhost fallback matches the ServerHoster dev port so
 * local builds produce coherent absolute URLs too.
 */
export const SITE_URL: string = (
  process.env['NEXT_PUBLIC_SITE_URL'] ?? 'http://localhost:3004'
).replace(/\/+$/, '');

/** Absolute URL for a site-relative path ("/hub" → "<SITE_URL>/hub"). */
export function absoluteUrl(path: string): string {
  return `${SITE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * Serialize an object for a `<script type="application/ld+json">` block.
 * Escapes `<` so user-authored strings (game titles, bios) can never close the
 * script tag and inject markup.
 */
export function safeJsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}
