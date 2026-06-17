/**
 * IMPROVEMENT_BACKLOG #47 — bootstrap injection hardening.
 *
 * The Three.js + Phaser bootstraps interpolate `gameBaseUrl` and the
 * pinned engine version directly into generated HTML (attribute + URL
 * contexts). If either value is ever attacker- or spec-influenced (a
 * remixed design, a crafted version pin, a future caller that forwards an
 * untrusted base), an un-escaped `"` or `<` breaks out of the attribute and
 * injects markup/script into the privileged iframe document. These helpers
 * neutralise that vector:
 *
 *  - `escapeHtml` / `escapeAttribute` HTML-escape the dangerous characters
 *    before interpolation, so a quote/angle-bracket in `gameBaseUrl` can no
 *    longer terminate the `<base href="…">` attribute.
 *  - `assertSemver` rejects any engine version that is not a strict semver,
 *    so a version pin can never smuggle `"/><script>…` into the import-map
 *    URL.
 *  - `sanitizeGameBaseUrl` re-specs `gameBaseUrl` to the small set of bases
 *    the iframe is allowed to resolve against (https, about:blank, and the
 *    privileged `game-files://` protocol) and hard-rejects `javascript:` /
 *    `data:` bases.
 */

/**
 * HTML-escape text destined for an element text context. Escapes the five
 * characters that are special in HTML so generated markup can never be
 * re-interpreted as tags/entities.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Escape a value destined for a double-quoted HTML attribute. Same character
 * set as {@link escapeHtml}; kept as a distinct name so call sites document
 * the context they are writing into.
 */
export function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

/**
 * Strict semver matcher (semver.org BNF, simplified): MAJOR.MINOR.PATCH with
 * optional `-prerelease` and `+build` metadata made of dot-separated
 * alphanumeric/hyphen identifiers. No leading `v`, no ranges, no wildcards.
 */
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/**
 * Validate an engine version against {@link SEMVER_RE} and return it
 * unchanged, or throw if it is not a strict semver. Called before the
 * version is ever interpolated into an import-map URL, so a crafted pin
 * (e.g. `0.170.0"/></script><script>…`) is rejected rather than escaped —
 * an engine version is a structural value, not free text.
 */
export function assertSemver(version: string): string {
  if (!SEMVER_RE.test(version)) {
    throw new Error(
      `Invalid engine version "${version}": must be a strict semver (MAJOR.MINOR.PATCH). Refusing to interpolate a non-semver version into the bootstrap import-map.`,
    );
  }
  return version;
}

/**
 * Re-spec `gameBaseUrl` to the bases the privileged iframe is allowed to
 * resolve relative imports/assets against:
 *
 *  - `https:`            — public/CDN-style absolute bases
 *  - `about:blank`       — the inert default base
 *  - `game-files://…`    — the runtime's privileged asset protocol
 *
 * Anything else — most importantly `javascript:` and `data:` bases, but also
 * `http:`, `file:`, `blob:`, etc. — is rejected. The returned string is the
 * *unescaped* URL; callers must still {@link escapeAttribute} it before
 * interpolation (a perfectly valid `https://…?q="><svg` base is in-scheme
 * yet still needs attribute escaping).
 */
export function sanitizeGameBaseUrl(gameBaseUrl: string): string {
  const trimmed = gameBaseUrl.trim();
  if (trimmed === 'about:blank') return trimmed;

  // Scheme test on the raw string (don't rely on URL parsing, which would
  // happily accept `javascript:` and also normalise away the original form).
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed);
  const scheme = schemeMatch?.[1]?.toLowerCase();

  if (scheme === undefined) {
    throw new Error(
      `Invalid gameBaseUrl "${gameBaseUrl}": expected an absolute https://, about:blank, or game-files:// base.`,
    );
  }

  if (scheme === 'https' || scheme === 'game-files') return trimmed;

  throw new Error(
    `Refusing gameBaseUrl "${gameBaseUrl}": scheme "${scheme}:" is not allowed. The bootstrap <base href> must be https://, about:blank, or game-files:// — javascript:/data:/file:/blob: bases are rejected.`,
  );
}

/**
 * IMPROVEMENT_BACKLOG #41 (runtime half) — anti-exfil visibility.
 *
 * The cloud CSP pins `connect-src 'self'`, so generated games that reach the
 * network (fetch / XMLHttpRequest / WebSocket / EventSource / sendBeacon /
 * navigator.connection) to a non-self origin will be *blocked at runtime*.
 * Rather than let that surface only as an opaque console error in the
 * iframe, we surface it at validate-time as a WARNING (never a hard failure —
 * a same-origin fetch of a bundled asset is legitimate). This makes the
 * anti-exfil expectation visible while the agent still has the file open.
 *
 * Heuristic only (regex, no AST). Returns the network primitive names that
 * appear in the code so the caller can name them in the warning.
 */
const NETWORK_PRIMITIVE_RES: ReadonlyArray<readonly [string, RegExp]> = [
  ['fetch', /\bfetch\s*\(/],
  ['XMLHttpRequest', /\bnew\s+XMLHttpRequest\b|\bXMLHttpRequest\s*\(/],
  ['WebSocket', /\bnew\s+WebSocket\b/],
  ['EventSource', /\bnew\s+EventSource\b/],
  ['sendBeacon', /\bnavigator\s*\.\s*sendBeacon\s*\(/],
];

/**
 * Scan game JS for network primitives. Returns the deduped, source-ordered
 * list of primitive names that appear (empty when none do).
 */
export function detectNetworkReferences(js: string): string[] {
  const hits: string[] = [];
  for (const [name, re] of NETWORK_PRIMITIVE_RES) {
    if (re.test(js)) hits.push(name);
  }
  return hits;
}

/**
 * Build the shared anti-exfil warning message for the given primitives.
 */
export function networkReferenceWarning(primitives: readonly string[]): string {
  return `anti_exfil: generated code references the network (${primitives.join(
    ', ',
  )}). The cloud sandbox pins CSP \`connect-src 'self'\`, so any request to a non-self origin is blocked at runtime — and the platform treats outbound data flow as untrusted exfiltration. Keep all requests same-origin (bundled assets) or remove them. This is a warning, not a failure.`;
}
