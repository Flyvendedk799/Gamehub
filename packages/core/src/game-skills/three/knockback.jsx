// when_to_use: Three.js knockback + stagger + hit-flash — physically shove a
// target away from an impact and briefly stun it. The companion to camera
// shake (camera felt it) and hitstop (time felt it): knockback says the
// TARGET felt it. Works with whatever movement integration you use — it
// either writes a velocity you integrate, or eases a position offset
// directly. Includes a material emissive/color hit-flash so the struck mesh
// blinks on contact (instant "I connected" read, even before particles).

import * as THREE from 'three';

/** Compute a knockback velocity vector away from `sourcePos`. Add it to your
 *  actor's velocity (you integrate `pos += vel * dt` with your own damping). */
export function knockbackVelocity(targetPos, sourcePos, power = 8, lift = 3) {
  const dir = new THREE.Vector3().subVectors(targetPos, sourcePos);
  dir.y = 0; // keep the shove horizontal; lift is added separately
  if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
  dir.normalize().multiplyScalar(power);
  dir.y += lift;
  return dir;
}

/** Stateful stagger: marks an actor stunned for `ms`, ticked off real time.
 *  Check `state.stunned` at the top of the actor's update to skip AI/input. */
export function makeStagger() {
  let until = 0;
  return {
    stun(ms = 180) {
      until = Math.max(until, performance.now() + ms);
    },
    get stunned() {
      return performance.now() < until;
    },
  };
}

/** Blink a mesh white for `ms`, restoring its original color. Works on a
 *  standard material with `.color` (and `.emissive` if present). */
export function hitFlashMesh(mesh, ms = 90) {
  const mat = mesh.material;
  if (!mat || !mat.color) return;
  if (mesh._feelOrigColor === undefined) {
    mesh._feelOrigColor = mat.color.getHex();
    mesh._feelOrigEmissive = mat.emissive ? mat.emissive.getHex() : null;
  }
  mat.color.setHex(0xffffff);
  if (mat.emissive) mat.emissive.setHex(0x888888);
  window.setTimeout(() => {
    mat.color.setHex(mesh._feelOrigColor);
    if (mat.emissive && mesh._feelOrigEmissive !== null) {
      mat.emissive.setHex(mesh._feelOrigEmissive);
    }
  }, ms);
}

// Usage:
//   const enemyStagger = makeStagger();
//   function onEnemyHit(enemy, attackerPos) {
//     enemy.vel.add(knockbackVelocity(enemy.mesh.position, attackerPos, 9, 4));
//     enemyStagger.stun(220);
//     hitFlashMesh(enemy.mesh);
//   }
//   function updateEnemy(dt) {
//     if (enemyStagger.stunned) { /* skip AI; still integrate vel below */ }
//     enemy.mesh.position.addScaledVector(enemy.vel, dt);
//     enemy.vel.multiplyScalar(Math.exp(-6 * dt)); // damping
//   }
