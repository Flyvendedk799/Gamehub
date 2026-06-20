// when_to_use: ANY 3D game with a movable camera — first-person OR third-person /
// follow. This fixes the #1 recurring 3D bug: world-relative WASD that mismatches
// the camera so the controls "feel inverted" when the camera turns, plus no
// vertical look and an over-springy camera. The trick that makes it impossible to
// get wrong: movement is derived from the camera's ACTUAL forward
// (camera.getWorldDirection), so "forward" is always "into the screen" no matter
// where the camera points — you never hand-write sin/cos sign math for movement.
//
// Usage (THREE is already imported in your project):
//   const cam = makeCameraController(camera, renderer.domElement, { mode: 'thirdPerson' });
//   // optional: cam.requestLock() on a click for FPS-style mouse capture.
//   // each frame, AFTER reading your controls:
//   const strafe  = (controls.isDown('moveRight') ? 1 : 0) - (controls.isDown('moveLeft') ? 1 : 0);
//   const forward = (controls.isDown('moveForward') ? 1 : 0) - (controls.isDown('moveBack') ? 1 : 0);
//   const move = cam.moveVector(strafe, forward);      // camera-relative, ground-plane
//   player.position.addScaledVector(move, speed * dt);
//   cam.update(player.position, dt);                   // follow + aim
//
// RULES this encodes (don't break them when you adapt it):
//   1. Movement uses the camera basis, NOT world axes — else controls mismatch.
//   2. Pitch is CLAMPED so the camera can never flip / gimbal-lock.
//   3. Sensitivity is LOW + constant; never multiply mouse deltas by huge numbers
//      or by dt — that's the "springy/extreme" feel.
//   4. The camera is driven by the MOUSE, not by the player's facing — a camera
//      that re-aims itself to the player's heading swings unpredictably.

const UP = new THREE.Vector3(0, 1, 0);

export function makeCameraController(camera, dom, opts = {}) {
  const mode = opts.mode || 'thirdPerson'; // 'thirdPerson' | 'firstPerson'
  const sensitivity = opts.sensitivity ?? 0.0022; // radians per pixel — keep small
  const minPitch = opts.minPitch ?? (mode === 'firstPerson' ? -1.45 : -1.2);
  const maxPitch = opts.maxPitch ?? (mode === 'firstPerson' ? 1.45 : 0.5);
  const distance = opts.distance ?? 6; // third-person boom length
  const height = opts.height ?? 1.6; // eye / look-at height above the target
  const follow = opts.follow ?? 0.12; // third-person smoothing (0..1-ish); small = smooth, NOT springy
  let yaw = opts.yaw ?? Math.PI; // start looking down -z by default
  let pitch = opts.pitch ?? (mode === 'thirdPerson' ? -0.25 : 0);
  let invertY = opts.invertY ?? false;
  let locked = false;
  let dragging = false;

  const onMove = (e) => {
    if (!locked && !dragging) return; // unlocked: only look while a button is held
    yaw -= e.movementX * sensitivity; // look right → turn right
    pitch += (invertY ? 1 : -1) * e.movementY * sensitivity; // mouse up → look up
    if (pitch < minPitch) pitch = minPitch;
    else if (pitch > maxPitch) pitch = maxPitch; // CLAMP — never flip
  };
  dom.addEventListener('pointerdown', () => {
    dragging = true;
  });
  window.addEventListener('pointerup', () => {
    dragging = false;
  });
  window.addEventListener('mousemove', onMove);
  document.addEventListener('pointerlockchange', () => {
    locked = document.pointerLockElement === dom;
  });

  const _f = new THREE.Vector3();
  const _r = new THREE.Vector3();
  const _out = new THREE.Vector3();
  const _aim = new THREE.Vector3();
  const _desired = new THREE.Vector3();
  const _target = new THREE.Vector3();

  // Forward / right from yaw+pitch (used to aim the camera). Consistent with the
  // basis moveVector() reads back from the camera, so movement always matches view.
  function lookDir(out) {
    const cp = Math.cos(pitch);
    return out.set(Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp);
  }

  return {
    get yaw() {
      return yaw;
    },
    get pitch() {
      return pitch;
    },
    setInvertY(v) {
      invertY = !!v;
    },
    requestLock() {
      try {
        dom.requestPointerLock?.();
      } catch (_) {}
    },

    // Camera-relative move vector on the GROUND plane. strafe = right−left,
    // forward = forward−back. Reads the camera's REAL forward so "forward" is
    // always into the screen — the part you must never reimplement with raw axes.
    moveVector(strafe, forward) {
      camera.getWorldDirection(_f);
      _f.y = 0;
      if (_f.lengthSq() < 1e-6) _f.set(0, 0, -1);
      _f.normalize();
      _r.crossVectors(_f, UP).normalize(); // right = forward × up
      _out.copy(_f).multiplyScalar(forward).addScaledVector(_r, strafe);
      if (_out.lengthSq() > 1) _out.normalize();
      return _out;
    },

    // Place + aim the camera at the follow target (e.g. the player position).
    update(targetPos, dt) {
      _target.copy(targetPos);
      _target.y += height;
      if (mode === 'firstPerson') {
        camera.position.copy(_target);
        camera.lookAt(_aim.copy(_target).add(lookDir(_f)));
      } else {
        // Boom behind the target along the look direction; pitch lifts it.
        lookDir(_f);
        _desired
          .copy(_target)
          .addScaledVector(_f, -distance)
          .add(_aim.set(0, Math.max(0, Math.sin(-pitch)) * distance + 1.2, 0));
        const k = 1 - (1 - follow) ** (dt * 60); // frame-rate-independent, never springy
        camera.position.lerp(_desired, Math.min(1, k));
        camera.lookAt(_target);
      }
    },
  };
}
