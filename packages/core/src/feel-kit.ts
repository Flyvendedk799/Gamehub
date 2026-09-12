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

/**
 * A drawing path that is JUST tinted primitives — one box or circle standing in
 * for a character — with no real subject anywhere.
 *
 * Two blind spots closed after run 54842529 (a UFC fighter), where this fired for
 * three straight `done` calls against an articulated fighter body:
 *
 *  1. `window.__game.art.draw(ctx, noun, …)` — the platform's OWN procedural-art
 *     library, the thing the prompts tell the agent to reach for — did not count as
 *     a subject path. Using the recommended API read as using no API.
 *  2. A hand-drawn 2D subject IS primitives: that fighter's torso, head, arms,
 *     legs and gloves were ~40 `fillRect` calls with per-part geometry. Volume of
 *     distinct draw calls is the difference between a body and a box, so a draw
 *     path with many of them is a subject, whatever it is made of.
 *
 * The agent's eventual escape from (1)/(2) was to add `function drawPlayer(g, f) {
 * f.draw(); }` — a no-op alias written purely to satisfy a name match. A gate that
 * is answerable by renaming something is measuring the wrong thing.
 */
const SUBJECT_DRAW_CALL_FLOOR = 12;

export function looksCircleOnlySubject(source: string): boolean {
  const primitiveCalls = [
    ...source.matchAll(
      /\b(?:fillRect|fillCircle|strokeRect|ellipse|arc|moveTo|lineTo|quadraticCurveTo|bezierCurveTo)\s*\(/g,
    ),
  ].length;
  const hasCircles =
    primitiveCalls > 0 || /new\s+THREE\.(?:Mesh|BoxGeometry|SphereGeometry)/.test(source);
  const hasSubject =
    /drawSubject|drawPlayer|drawEnemy|drawHero|generate_image_asset|load\.\w+\(['"][^'"]+/.test(
      source,
    ) ||
    /GLTFLoader|assets\/models\//.test(source) ||
    // The platform's own representational-art library counts as a subject path.
    /\bart\.draw\s*\(|__game\.art\b/.test(source) ||
    // A drawing routine built from many distinct primitives is a real subject.
    primitiveCalls >= SUBJECT_DRAW_CALL_FLOOR;
  return hasCircles && !hasSubject;
}
