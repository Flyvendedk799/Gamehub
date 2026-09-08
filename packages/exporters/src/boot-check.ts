/**
 * S14 — boot-check a published/exported HTML bundle before handing it to the
 * user (itch zip / embed). Uses the same runtime-verify contract as the
 * browser-worker; this module is the pure gate the API calls after bundling.
 */

export interface BootCheckInput {
  /** True when window.__game appeared. */
  hasGameContract: boolean;
  fatalErrors: readonly string[];
  /** Engine the project claims vs engine the HTML actually boots. */
  declaredEngine: 'phaser' | 'three' | 'canvas2d';
  /** Detected from the bundle (import map / CDN / canvas2d markers). */
  detectedEngine: 'phaser' | 'three' | 'canvas2d' | 'unknown';
  audioPlays?: number;
  requireAudio?: boolean;
}

export interface BootCheckResult {
  ok: boolean;
  errors: string[];
}

export function evaluateBootCheck(input: BootCheckInput): BootCheckResult {
  const errors: string[] = [];
  if (!input.hasGameContract) {
    errors.push('bundle does not expose window.__game (did not boot)');
  }
  if (input.fatalErrors.length > 0) {
    errors.push(`fatal boot errors: ${input.fatalErrors.slice(0, 3).join('; ')}`);
  }
  if (input.detectedEngine !== 'unknown' && input.detectedEngine !== input.declaredEngine) {
    errors.push(
      `engine mismatch: project declares ${input.declaredEngine} but bundle boots ${input.detectedEngine}`,
    );
  }
  if (input.requireAudio && (input.audioPlays ?? 0) <= 0) {
    errors.push('requireAudio set but audioPlays == 0 (silent bundle)');
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Text MIME types worth decoding out of a `data:` URL when scanning a bundle.
 * Images, audio, fonts and models are megabytes of base64 that can never
 * contain a `window.__game` or an engine marker, so decoding them would only
 * burn memory.
 */
const TEXT_DATA_URL_RE =
  /data:(?:text\/(?:javascript|css|html|plain)|application\/(?:javascript|ecmascript|json))(?:;charset=[\w-]+)?;base64,([A-Za-z0-9+/=]+)/g;

/**
 * Make an exported bundle SEARCHABLE.
 *
 * `buildGameHtml` produces a single self-contained file by rewriting every
 * module into a base64 `data:` URL. That is correct for shipping — and it made
 * every static scan over the result structurally blind, because the game's
 * entire source (including `window.__game` and its engine import) survives only
 * as base64. So the publish gate asked "does this bundle expose window.__game?"
 * of a string in which no game source is legible, got "no", and returned 422 for
 * every multi-file game — i.e. all of them. The bundles booted fine; the check
 * simply could not read them. (The thumbnail capture boots this same HTML in a
 * real browser and succeeds, which is what proves it.)
 *
 * This decodes the text `data:` payloads back and appends them, so a scan sees
 * the source as authored. Bounded: a decode failure is skipped, and the total
 * appended text is capped so a pathological bundle can't blow up memory.
 */
export function searchableBundleSource(html: string): string {
  const decoded: string[] = [];
  let budget = 4 * 1024 * 1024; // 4 MB of decoded text is far past any real game
  for (const match of html.matchAll(TEXT_DATA_URL_RE)) {
    const payload = match[1];
    if (payload === undefined) continue;
    if (budget <= 0) break;
    try {
      const text = Buffer.from(payload, 'base64').toString('utf8');
      decoded.push(text.slice(0, budget));
      budget -= text.length;
    } catch {
      /* not valid base64 after all — nothing to add */
    }
  }
  return decoded.length === 0 ? html : `${html}\n${decoded.join('\n')}`;
}

/**
 * True when the bundle exposes the `window.__game` contract. Runs over the
 * DECODED bundle (see `searchableBundleSource`) so an inlined module counts.
 */
export function bundleHasGameContract(html: string): boolean {
  return /window\.__game|__game\s*=/.test(searchableBundleSource(html));
}

/** Cheap static detection of which engine an HTML bundle references. */
export function detectEngineFromHtml(html: string): 'phaser' | 'three' | 'canvas2d' | 'unknown' {
  // Scan the DECODED bundle: an exported single-file game carries its engine
  // import inside a base64 data: URL, where none of these patterns can match.
  const source = searchableBundleSource(html);
  if (/phaser(@|\/|\.esm|\.min)/i.test(source) || /from\s+['"]phaser['"]/.test(source)) {
    return 'phaser';
  }
  if (/three(@|\/|\.module)|from\s+['"]three['"]/i.test(source)) return 'three';
  if (/getContext\s*\(\s*['"]2d['"]\s*\)/.test(source) && !/phaser|three/i.test(source)) {
    return 'canvas2d';
  }
  return 'unknown';
}
