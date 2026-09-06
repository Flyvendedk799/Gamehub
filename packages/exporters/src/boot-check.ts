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
  if (
    input.detectedEngine !== 'unknown' &&
    input.detectedEngine !== input.declaredEngine
  ) {
    errors.push(
      `engine mismatch: project declares ${input.declaredEngine} but bundle boots ${input.detectedEngine}`,
    );
  }
  if (input.requireAudio && (input.audioPlays ?? 0) <= 0) {
    errors.push('requireAudio set but audioPlays == 0 (silent bundle)');
  }
  return { ok: errors.length === 0, errors };
}

/** Cheap static detection of which engine an HTML bundle references. */
export function detectEngineFromHtml(html: string): 'phaser' | 'three' | 'canvas2d' | 'unknown' {
  if (/phaser(@|\/|\.esm|\.min)/i.test(html) || /from\s+['"]phaser['"]/.test(html)) return 'phaser';
  if (/three(@|\/|\.module)|from\s+['"]three['"]/i.test(html)) return 'three';
  if (/getContext\s*\(\s*['"]2d['"]\s*\)/.test(html) && !/phaser|three/i.test(html)) {
    return 'canvas2d';
  }
  return 'unknown';
}
