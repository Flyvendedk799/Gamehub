/**
 * Do the controls still follow the screen?
 *
 * Run e229481c changed the camera from a front-ish view to a side-on one and left every control
 * mapped to the old orientation. "Forward" now ran along the screen's horizontal axis and
 * "strafe right" ran straight into the depth of the picture. Every automated check passed,
 * because none of them ever asked the question a player asks in the first second: when I press
 * right, does my character go right?
 *
 * The check: hold the right key and the left key, and see where the player lands on the SCREEN
 * (projected through the game's own camera). Holding right must move the player to the right of
 * where they were; holding left, to the left. It is geometry, not opinion, and it holds for any
 * game with a camera, whichever way the camera points.
 *
 * It abstains whenever it cannot be sure: no camera, no player position, or a player who did not
 * move (the key may be a dodge, or the player is against a wall).
 */

export interface ScreenPoint {
  /** Normalised device x: -1 is the left edge of the screen, +1 the right. */
  x: number;
  y: number;
}

export interface ScreenProbeStep {
  code: string;
  snapshotAfter: unknown;
  screenAfter: ScreenPoint | null | undefined;
}

export interface ScreenProbeInput {
  baselineSnapshot: unknown;
  baselineScreen: ScreenPoint | null | undefined;
  steps: readonly ScreenProbeStep[];
}

export interface ScreenControlsVerdict {
  /** How many key presses could actually be judged. Zero means "no opinion". */
  checked: number;
  violations: string[];
}

/** The key presses the probe sends: both common bindings, each way. */
export const SCREEN_PROBE_KEYS: ReadonlyArray<{ code: string; direction: 'right' | 'left' }> = [
  { code: 'KeyD', direction: 'right' },
  { code: 'KeyA', direction: 'left' },
  { code: 'ArrowRight', direction: 'right' },
  { code: 'ArrowLeft', direction: 'left' },
];

/** Frames each probe key is held: enough to move, short enough to stay inside the arena. */
export const SCREEN_PROBE_FRAMES = 22;

/** Less movement than this (in world units) is "did not move": nothing to judge. */
const MIN_WORLD_MOVE = 0.25;
/** The screen shift (of a 2.0-wide screen) that counts as really moving the right way. */
const MIN_SCREEN_SHIFT = 0.04;

function positionOf(snapshot: unknown): { x: number; y: number; z: number } | null {
  if (snapshot === null || typeof snapshot !== 'object') return null;
  const p = (snapshot as { playerPos?: unknown }).playerPos;
  if (p === null || typeof p !== 'object') return null;
  const { x, y, z } = p as { x?: unknown; y?: unknown; z?: unknown };
  if (typeof x !== 'number' || typeof z !== 'number') return null;
  return { x, y: typeof y === 'number' ? y : 0, z };
}

export function evaluateScreenControls(input: ScreenProbeInput): ScreenControlsVerdict {
  const violations: string[] = [];
  let checked = 0;
  let beforePos = positionOf(input.baselineSnapshot);
  let beforeScreen = input.baselineScreen ?? null;

  for (const step of input.steps) {
    const afterPos = positionOf(step.snapshotAfter);
    const afterScreen = step.screenAfter ?? null;
    const direction = SCREEN_PROBE_KEYS.find((k) => k.code === step.code)?.direction;

    if (
      direction !== undefined &&
      beforePos !== null &&
      afterPos !== null &&
      beforeScreen !== null &&
      afterScreen !== null
    ) {
      const moved = Math.hypot(
        afterPos.x - beforePos.x,
        afterPos.y - beforePos.y,
        afterPos.z - beforePos.z,
      );
      if (moved >= MIN_WORLD_MOVE) {
        checked += 1;
        const shift = afterScreen.x - beforeScreen.x;
        const wrong = direction === 'right' ? shift < MIN_SCREEN_SHIFT : shift > -MIN_SCREEN_SHIFT;
        if (wrong) {
          const percent = Math.round((Math.abs(shift) / 2) * 100);
          const wentThe =
            Math.abs(shift) < MIN_SCREEN_SHIFT
              ? 'almost straight toward or away from the camera'
              : shift < 0
                ? 'to the LEFT'
                : 'to the RIGHT';
          violations.push(
            `Holding ${step.code} (${direction}) moved the player ${wentThe} on screen (${percent}% of the screen width), not ${direction}.`,
          );
        }
      }
    }
    // The next key is judged from where this one left the player.
    if (afterPos !== null) beforePos = afterPos;
    if (afterScreen !== null) beforeScreen = afterScreen;
  }
  return { checked, violations };
}

/** What a repair must do. Quoted to the agent verbatim when the check fails. */
export function controlsFollowCameraAdvice(violations: readonly string[]): string {
  return [
    'The controls do not follow the camera. On screen, the player must move the way the key points:',
    ...violations.map((v) => `  - ${v}`),
    '',
    'This happens when the camera is moved or turned but the movement and dodge code still uses the old fixed directions (world axes, or a direction relative to the opponent). Fix it by deriving every movement direction from the camera itself, each frame:',
    '  const fwd = new THREE.Vector3(); camera.getWorldDirection(fwd); fwd.y = 0; fwd.normalize();',
    '  const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();',
    '  // right key / D  => move along +right;  left key / A => along -right;',
    '  // up key / W     => move along +fwd (away from the camera, up the screen);  down key / S => -fwd',
    'In a side-on view that means left and right move the player left and right on screen (W/S still go along the depth axis). Apply the same basis to dodges and any aim or knockback that uses the input direction. Do not change the camera back: change how the input is turned into movement.',
  ].join('\n');
}
