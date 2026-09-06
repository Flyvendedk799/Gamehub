// when_to_use: First-person / third-person character locomotion for Three.js.
// Pointer-lock yaw/pitch, wishdir movement, ground snap. Seed into
// src/engine/fps-controller.jsx (or tps-controller.jsx) and CALL it.
//
// S4 / S8 — Summer's 3D templates ship a working character. Ours must too.

/**
 * @param {object} opts
 * @param {number} [opts.moveSpeed=7]
 * @param {number} [opts.lookSensitivity=0.002]
 * @param {number} [opts.pitchMin=-1.4]
 * @param {number} [opts.pitchMax=1.4]
 * @param {'fps'|'tps'} [opts.mode='fps']
 */
export function createFpsController(opts = {}) {
  const moveSpeed = opts.moveSpeed ?? 7;
  const lookSensitivity = opts.lookSensitivity ?? 0.002;
  const pitchMin = opts.pitchMin ?? -1.4;
  const pitchMax = opts.pitchMax ?? 1.4;
  const mode = opts.mode ?? 'fps';

  let yaw = 0;
  let pitch = 0;
  const position = { x: 0, y: 1.6, z: 0 };
  let pointerLocked = false;

  return {
    setPointerLocked(locked) {
      pointerLocked = !!locked;
    },
    /** Apply mouse deltas (movementX/Y). No-ops until pointer is locked. */
    look(movementX, movementY) {
      if (!pointerLocked) return { yaw, pitch };
      yaw -= movementX * lookSensitivity;
      pitch -= movementY * lookSensitivity;
      if (pitch < pitchMin) pitch = pitchMin;
      if (pitch > pitchMax) pitch = pitchMax;
      return { yaw, pitch };
    },
    /**
     * Camera-relative wishdir move. forward/strafe in [-1,1].
     * Never does `rotation.y = -playerAngle` — yaw drives both look and move.
     */
    step(dt, { forward = 0, strafe = 0 } = {}) {
      const dts = Math.min(0.05, Math.max(0, dt));
      const sin = Math.sin(yaw);
      const cos = Math.cos(yaw);
      // Camera basis on XZ: forward = (-sin, 0, -cos), right = (cos, 0, -sin)
      const fx = -sin;
      const fz = -cos;
      const rx = cos;
      const rz = -sin;
      position.x += (fx * forward + rx * strafe) * moveSpeed * dts;
      position.z += (fz * forward + rz * strafe) * moveSpeed * dts;
      return { position: { ...position }, yaw, pitch, pointerLocked, mode };
    },
    getState() {
      return { position: { ...position }, yaw, pitch, pointerLocked, mode };
    },
    /** TPS helper: orbit camera offset behind the body. */
    getCameraOffset(distance = 4, height = 1.5) {
      return {
        x: position.x + Math.sin(yaw) * distance,
        y: position.y + height,
        z: position.z + Math.cos(yaw) * distance,
      };
    },
    reset(x = 0, y = 1.6, z = 0) {
      position.x = x;
      position.y = y;
      position.z = z;
      yaw = 0;
      pitch = 0;
    },
  };
}

export function createTpsController(opts = {}) {
  return createFpsController({ ...opts, mode: 'tps' });
}
