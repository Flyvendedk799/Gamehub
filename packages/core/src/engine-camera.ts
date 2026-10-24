/**
 * Make the 3D engine module publish its camera.
 *
 * Why: whether the controls still match what the player sees is a property of the CAMERA, and the
 * only party that can check it from outside the game is the play-check. It can only project the
 * player onto the screen if it can reach the camera. Games built on the starter all get their
 * camera from `createStage()` in `src/engine/core.js`, so publishing it there covers every one of
 * them, whatever the game code later does to it.
 *
 * Run e229481c moved the camera to a side-on view and left the controls mapped to the old
 * orientation; nothing could notice, because nothing could see the camera.
 *
 * The same function patches the starter text itself AND existing projects whose engine module was
 * seeded before this existed, so both end up byte-identical (and a project still sitting on the
 * pristine starter is still recognised as pristine).
 */

const CAMERA_DECL =
  /^([ \t]*)(?:const|let)\s+camera\s*=\s*new\s+THREE\.(?:Perspective|Orthographic)Camera\([^;\n]*\);[ \t]*$/m;

/** Inserted after the camera is created. `try` because the host's `__game` may be sealed. */
const PUBLISH = 'try { window.__game.camera = camera; } catch { /* sealed contract: skip */ }';

/** The engine module with its camera published. Idempotent; unchanged when it has no camera. */
export function exposeCameraInEngine(content: string): string {
  if (/__game\.camera\b/.test(content)) return content;
  const match = CAMERA_DECL.exec(content);
  if (match === null) return content;
  const end = match.index + match[0].length;
  const indent = match[1] ?? '';
  return `${content.slice(0, end)}\n${indent}${PUBLISH}${content.slice(end)}`;
}
