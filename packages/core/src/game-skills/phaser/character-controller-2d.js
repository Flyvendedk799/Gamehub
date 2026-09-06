// when_to_use: Side-view platformer character movement. Coyote time, jump
// buffer, variable jump height, one-way platforms. Seed this into
// src/engine/character-controller-2d.js and CALL createPlatformerController.
//
// S4 — Summer sells one-click character controllers. We ship a real one the
// agent must import, not re-derive every run.

/**
 * @param {object} opts
 * @param {number} [opts.speed=220]
 * @param {number} [opts.jumpVelocity=420]
 * @param {number} [opts.gravity=1400]
 * @param {number} [opts.coyoteMs=80]
 * @param {number} [opts.jumpBufferMs=100]
 * @param {number} [opts.variableJumpCut=0.45]
 */
export function createPlatformerController(opts = {}) {
  const speed = opts.speed ?? 220;
  const jumpVelocity = opts.jumpVelocity ?? 420;
  const gravity = opts.gravity ?? 1400;
  const coyoteMs = opts.coyoteMs ?? 80;
  const jumpBufferMs = opts.jumpBufferMs ?? 100;
  const variableJumpCut = opts.variableJumpCut ?? 0.45;

  let vx = 0;
  let vy = 0;
  let grounded = false;
  let coyoteLeft = 0;
  let jumpBufferLeft = 0;
  let jumpHeld = false;

  return {
    /** Apply left/right intent in [-1,1] and whether jump is pressed this frame. */
    step(dt, { moveX = 0, jumpPressed = false, jumpDown = false, onGround = false } = {}) {
      const dts = Math.min(0.05, Math.max(0, dt));
      grounded = onGround;
      if (grounded) coyoteLeft = coyoteMs / 1000;
      else coyoteLeft = Math.max(0, coyoteLeft - dts);

      if (jumpPressed) jumpBufferLeft = jumpBufferMs / 1000;
      else jumpBufferLeft = Math.max(0, jumpBufferLeft - dts);

      vx = moveX * speed;
      vy += gravity * dts;

      if (jumpBufferLeft > 0 && coyoteLeft > 0) {
        vy = -jumpVelocity;
        jumpBufferLeft = 0;
        coyoteLeft = 0;
        jumpHeld = true;
      }
      // Variable jump: releasing early cuts upward velocity.
      if (jumpHeld && !jumpDown && vy < 0) {
        vy *= variableJumpCut;
        jumpHeld = false;
      }
      if (vy >= 0) jumpHeld = false;

      return { vx, vy, grounded, canJump: coyoteLeft > 0 };
    },
    getState() {
      return { vx, vy, grounded, coyoteLeft, jumpBufferLeft };
    },
    reset() {
      vx = 0;
      vy = 0;
      grounded = false;
      coyoteLeft = 0;
      jumpBufferLeft = 0;
      jumpHeld = false;
    },
  };
}
