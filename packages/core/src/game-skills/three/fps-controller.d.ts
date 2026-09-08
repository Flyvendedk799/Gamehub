/**
 * Public type surface for the `fps-controller` / `tps-controller` camera skills
 * (the runtime is plain ESM the agent imports into the game). Declared so the
 * platform's own TypeScript can import them without enabling `allowJs` or
 * `jsx`. Same convention as `beatmap-synth.d.ts`; the `.jsx` remains the single
 * source of behaviour.
 *
 * The `.jsx` extension is historical — these files contain no JSX, they are
 * ESM modules named to sit alongside the other Three skills.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type CameraMode = 'fps' | 'tps';

export interface FpsControllerOptions {
  moveSpeed?: number;
  lookSensitivity?: number;
  /** Clamp for vertical look, in radians. */
  pitchLimit?: number;
  mode?: CameraMode;
  /** TPS only — camera distance behind the player. */
  distance?: number;
  /** TPS only — camera height above the player. */
  height?: number;
}

export interface FpsStepInput {
  /** Forward/back intent in [-1, 1]. */
  forward?: number;
  /** Strafe intent in [-1, 1]. */
  strafe?: number;
}

export interface FpsState {
  position: Vec3;
  yaw: number;
  pitch: number;
  pointerLocked: boolean;
  mode: CameraMode;
}

export interface FpsController {
  /** Apply a pointer-lock look delta. No-op while unlocked. */
  look(movementX: number, movementY: number): { yaw: number; pitch: number };
  step(dt: number, input?: FpsStepInput): FpsState;
  getState(): FpsState;
  /** Orbit-camera position behind the player for the current yaw (TPS framing). */
  getCameraOffset(distance?: number, height?: number): Vec3;
  setPointerLocked(locked: boolean): void;
  /** Teleport the player and clear look state. Defaults to eye-height origin. */
  reset(x?: number, y?: number, z?: number): void;
}

export function createFpsController(opts?: FpsControllerOptions): FpsController;
export function createTpsController(opts?: FpsControllerOptions): FpsController;
