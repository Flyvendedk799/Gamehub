// when_to_use: Three.js particle burst — a short outward spray of points at a
// world position (hit spark, pickup pop, explosion debris, death puff). Uses
// a single THREE.Points cloud with additive blending; particles fly out,
// fade, then the whole burst self-disposes (geometry + material) so many
// hits don't leak GPU memory. No texture needed — round points via the
// `sizeAttenuation` PointsMaterial. Drop the returned object's `update(dt)`
// into your render loop, or use the self-ticking variant.

import * as THREE from 'three';

/** Spawn a one-shot burst of `count` particles at `pos`. Returns the Points
 *  object plus an `update(dt)` you must call each frame until `done` is true.
 *  Auto-removes itself from `scene` and disposes when finished. */
export function particleBurst(scene, pos, opts = {}) {
  const count = opts.count ?? 24;
  const color = opts.color ?? 0xffd166;
  const speed = opts.speed ?? 6;
  const life = opts.life ?? 0.5; // seconds
  const gravity = opts.gravity ?? -9;

  const positions = new Float32Array(count * 3);
  const velocities = [];
  for (let i = 0; i < count; i += 1) {
    positions[i * 3] = pos.x;
    positions[i * 3 + 1] = pos.y;
    positions[i * 3 + 2] = pos.z;
    // Random direction on a sphere, scaled by speed.
    const dir = new THREE.Vector3(
      Math.random() * 2 - 1,
      Math.random() * 2 - 1,
      Math.random() * 2 - 1,
    )
      .normalize()
      .multiplyScalar(speed * (0.5 + Math.random()));
    velocities.push(dir);
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    color,
    size: opts.size ?? 0.18,
    transparent: true,
    opacity: 1,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  });
  const points = new THREE.Points(geom, mat);
  scene.add(points);

  let elapsed = 0;
  let done = false;
  const attr = geom.getAttribute('position');

  function dispose() {
    scene.remove(points);
    geom.dispose();
    mat.dispose();
    done = true;
  }

  return {
    points,
    get done() {
      return done;
    },
    update(dt) {
      if (done) return;
      elapsed += dt;
      if (elapsed >= life) {
        dispose();
        return;
      }
      for (let i = 0; i < count; i += 1) {
        const v = velocities[i];
        v.y += gravity * dt;
        attr.setX(i, attr.getX(i) + v.x * dt);
        attr.setY(i, attr.getY(i) + v.y * dt);
        attr.setZ(i, attr.getZ(i) + v.z * dt);
      }
      attr.needsUpdate = true;
      mat.opacity = 1 - elapsed / life;
    },
  };
}

// Usage:
//   const bursts = [];
//   function onHit(worldPos) {
//     bursts.push(particleBurst(scene, worldPos, { color: 0xff4d4d }));
//   }
//   function onUpdate(dt) {
//     for (let i = bursts.length - 1; i >= 0; i -= 1) {
//       bursts[i].update(dt);
//       if (bursts[i].done) bursts.splice(i, 1);
//     }
//   }
