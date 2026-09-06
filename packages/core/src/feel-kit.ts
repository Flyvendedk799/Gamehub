/**
 * S5 — feel-kit integrity.
 *
 * Premium starters ship sfx() + screen shake + particles. Agents that delete
 * the kit produce mute/flat games that still "pass" juice. This checksum
 * detects removal of the feel surface so `done` can refuse.
 */

const FEEL_KIT_MARKERS: readonly RegExp[] = [
  /\b(?:sfx|playSfx|playTone|playBeep)\s*\(/,
  /\b(?:shake|screenShake|addShake|camera\.shake)\s*\(/i,
  /\b(?:particle|emitParticle|burst|explode)\s*\(/i,
];

export interface FeelKitReport {
  ok: boolean;
  missing: string[];
}

export function checkFeelKit(source: string): FeelKitReport {
  const missing: string[] = [];
  const labels = ['sfx', 'shake', 'particles'] as const;
  FEEL_KIT_MARKERS.forEach((re, i) => {
    if (!re.test(source)) missing.push(labels[i]!);
  });
  return { ok: missing.length === 0, missing };
}

/** S5 — vision/heuristics: a representational subject drawn only as tinted
 *  circles/rects with no dedicated drawSubject / sprite / texture path. */
export function looksCircleOnlySubject(source: string): boolean {
  const hasCircles =
    /fillRect\s*\(|fillCircle\s*\(|arc\s*\([^)]*Math\.PI\s*\*\s*2/.test(source) ||
    /new\s+THREE\.(?:Mesh|BoxGeometry|SphereGeometry)/.test(source);
  const hasSubject =
    /drawSubject|drawPlayer|drawEnemy|drawHero|generate_image_asset|load\.\w+\(['"][^'"]+/.test(
      source,
    ) || /GLTFLoader|assets\/models\//.test(source);
  return hasCircles && !hasSubject;
}
