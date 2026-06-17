// when_to_use: Three.js squash & stretch + spawn pop — make a mesh feel
// elastic and alive by scaling it non-uniformly on impact/jump/spawn. Three
// has no tween engine, so this is a tiny self-contained spring you tick from
// the render loop: it eases the mesh's scale back to (1,1,1) after you bump
// it. Squash (flat + wide) on landing/hit, stretch (tall + thin) on jump,
// pop (overshoot) on spawn/pickup. Volume-preserving so it reads as
// "deforming", not "resizing".

import * as THREE from 'three';

/** Bind a springy scale controller to a mesh. Call `s.squash()` / `s.stretch()`
 *  / `s.pop()` on events and `s.update(dt)` each frame; it relaxes the mesh's
 *  scale back toward its base. Stores the base scale on first use. */
export function makeSquashStretch(mesh, opts = {}) {
  const base = mesh.scale.clone();
  const stiffness = opts.stiffness ?? 14; // higher = snappier return
  const target = base.clone();

  function setNonUniform(sx, sy, sz) {
    mesh.scale.set(base.x * sx, base.y * sy, base.z * sz);
  }

  return {
    /** Wide + short. Volume-preserving (xz expand as y shrinks). */
    squash(amount = 0.3) {
      const w = 1 + amount;
      const h = 1 - amount;
      setNonUniform(w, h, w);
    },
    /** Tall + thin. */
    stretch(amount = 0.28) {
      const h = 1 + amount;
      const w = 1 - amount * 0.6;
      setNonUniform(w, h, w);
    },
    /** Overshoot pop for spawn/pickup. */
    pop(amount = 0.35) {
      const s = 1 + amount;
      setNonUniform(s, s, s);
    },
    update(dt) {
      // Exponential ease of current scale → base scale.
      const k = 1 - Math.exp(-stiffness * dt);
      mesh.scale.lerp(target.copy(base), k);
    },
  };
}

// Usage:
//   const playerFeel = makeSquashStretch(playerMesh);
//   function onLand() { playerFeel.squash(0.3); }
//   function onJump() { playerFeel.stretch(0.28); }
//   function onSpawn(){ playerFeel.pop(0.4); }
//   function onUpdate(dt) { playerFeel.update(dt); }
