// when_to_use: Three.js camera screen-shake + directional kick — the core 3D
// impact primitive. Three has no built-in shake, so this is a trauma-based
// shaker you tick from your render loop. Add trauma on every hit/explosion/
// land; trauma decays each frame and offsets the camera by trauma² (the
// square makes small hits subtle and big hits punchy). Keep max offset tiny
// (a few world units / a few degrees) — over-shaking 3D nauseates fast.

import * as THREE from 'three';

/** Create a shaker bound to a camera. Call `shaker.add(amount)` on impact,
 *  `shaker.kick(dirVec3, power)` for a directional shove, and
 *  `shaker.update(dt)` once per frame AFTER you've set the camera's base
 *  position/rotation (it offsets relative to that base). */
export function makeCameraShaker(camera, opts = {}) {
  const maxPos = opts.maxPos ?? 0.4; // world units
  const maxRot = opts.maxRot ?? 0.05; // radians
  const decay = opts.decay ?? 1.6; // trauma units / sec
  let trauma = 0;
  let seed = Math.random() * 1000;
  const kick = new THREE.Vector3();

  // Cheap value-noise-ish: cycle a few sines per axis.
  const noise = (t) => Math.sin(t) * 0.6 + Math.sin(t * 2.3 + 1.7) * 0.4;

  return {
    /** Add trauma (0..1). Clamped. 0.4 = light hit, 0.8 = explosion. */
    add(amount) {
      trauma = Math.min(1, trauma + amount);
    },
    /** Directional one-shot shove along a (normalized-ish) vector. */
    kick(dir, power = 0.3) {
      kick.copy(dir).normalize().multiplyScalar(power);
      trauma = Math.min(1, trauma + 0.15);
    },
    update(dt) {
      // Ease the kick back to zero.
      kick.multiplyScalar(Math.max(0, 1 - dt * 8));
      if (trauma <= 0 && kick.lengthSq() < 1e-6) return;
      const shake = trauma * trauma; // square: subtle low end, punchy high end
      seed += dt * 25;
      camera.position.x += noise(seed) * maxPos * shake + kick.x;
      camera.position.y += noise(seed + 50) * maxPos * shake + kick.y;
      camera.position.z += kick.z;
      camera.rotation.z += noise(seed + 100) * maxRot * shake;
      trauma = Math.max(0, trauma - decay * dt);
    },
  };
}

// Usage:
//   const shaker = makeCameraShaker(camera);
//   function onHit(dmg)  { shaker.add(dmg > 30 ? 0.7 : 0.4); }
//   function onExplode() { shaker.add(0.9); }
//   // render loop — set the camera's intended pose, THEN apply shake:
//   function onUpdate(dt) {
//     camera.position.copy(followTarget);   // base pose
//     camera.rotation.set(rx, ry, 0);
//     shaker.update(dt);                     // additive offset on top
//   }
