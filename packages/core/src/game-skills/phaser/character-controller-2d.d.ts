/**
 * Public type surface for the `character-controller-2d` platformer skill (the
 * runtime JS is plain ESM the agent imports into the game). Declared here so
 * the platform's own TypeScript — notably `character-controllers.test.ts` —
 * can import it with types without enabling `allowJs`. Same convention as
 * `beatmap-synth.d.ts`; the `.js` remains the single source of behaviour.
 */

export interface PlatformerControllerOptions {
  speed?: number;
  jumpVelocity?: number;
  gravity?: number;
  /** Grace window after leaving a ledge during which a jump still fires. */
  coyoteMs?: number;
  /** Window before landing during which a pressed jump is remembered. */
  jumpBufferMs?: number;
  /** Fraction of upward velocity retained when jump is released early. */
  variableJumpCut?: number;
}

export interface PlatformerStepInput {
  /** Left/right intent in [-1, 1]. */
  moveX?: number;
  /** True on the frame the jump key went down. */
  jumpPressed?: boolean;
  /** True while the jump key is held (drives the variable-height cut). */
  jumpDown?: boolean;
  onGround?: boolean;
}

export interface PlatformerStepResult {
  vx: number;
  /** Negative is upward, matching the 2D screen-space convention. */
  vy: number;
  grounded: boolean;
  canJump: boolean;
}

export interface PlatformerController {
  step(dt: number, input?: PlatformerStepInput): PlatformerStepResult;
  reset(): void;
}

export function createPlatformerController(
  opts?: PlatformerControllerOptions,
): PlatformerController;
