// when_to_use: dt-driven keyframe / tween timeline for THREE.Object3D — the
// "juice" layer. Reach for this when you want to animate position, rotation,
// or scale of a mesh over time without a full animation library. Supports
// chained clips (play one after another) and parallel groups (all clips in the
// group run at the same time). Also ships squash/flash helpers: a one-liner
// for a hit reaction or collect pop that layered animators produce in seconds.
// All timing is dt-scaled so it stays correct at any frame rate. Designed to
// sit between the render loop and Three.js — no physics, no framework.

import * as THREE from 'three';

// Scratch vectors reused every frame.
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();

// ---------------------------------------------------------------------------
// Easing library (small, no dependencies).
// ---------------------------------------------------------------------------
export const Easing = {
  linear: (t) => t,
  easeIn: (t) => t * t,
  easeOut: (t) => 1 - (1 - t) * (1 - t),
  easeInOut: (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2),
  bounce: (t) => {
    const n1 = 7.5625;
    const d1 = 2.75;
    if (t < 1 / d1) return n1 * t * t;
    if (t < 2 / d1) {
      const u = t - 1.5 / d1;
      return n1 * u * u + 0.75;
    }
    if (t < 2.5 / d1) {
      const u = t - 2.25 / d1;
      return n1 * u * u + 0.9375;
    }
    const u = t - 2.625 / d1;
    return n1 * u * u + 0.984375;
  },
  elastic: (t) => {
    if (t === 0 || t === 1) return t;
    return -(2 ** (10 * t - 10)) * Math.sin(((t * 10 - 10.75) * (2 * Math.PI)) / 3);
  },
};

// ---------------------------------------------------------------------------
// Core clip type.
// ---------------------------------------------------------------------------

/** Create a tween clip that mutates an Object3D from its snapshot at start
 *  to `to` over `duration` seconds using `easing`.
 *
 *  to: { position?, rotation?, scale? }  — all THREE.Vector3 (rotation = Euler xyz).
 *  Returns a clip handle: { update(dt) → done:bool, reset(), onComplete }.
 */
export function clip(object3d, to, duration, easing = Easing.easeOut) {
  let t = 0;
  let fromPos;
  let fromRot;
  let fromScale;
  let started = false;
  let done = false;
  let _onComplete = null;

  function capture() {
    if (to.position) fromPos = object3d.position.clone();
    if (to.rotation) fromRot = object3d.rotation.toVector3(new THREE.Vector3());
    if (to.scale) fromScale = object3d.scale.clone();
  }

  function update(dt) {
    if (done) return true;
    if (!started) {
      capture();
      started = true;
    }
    t += dt;
    const k = easing(Math.min(t / duration, 1));
    if (to.position) {
      object3d.position.lerpVectors(fromPos, to.position, k);
    }
    if (to.rotation) {
      _v.lerpVectors(fromRot, to.rotation, k);
      object3d.rotation.setFromVector3(_v);
    }
    if (to.scale) {
      object3d.scale.lerpVectors(fromScale, to.scale, k);
    }
    if (t >= duration) {
      done = true;
      _onComplete?.();
    }
    return done;
  }

  function reset() {
    t = 0;
    started = false;
    done = false;
  }

  return {
    update,
    reset,
    set onComplete(fn) {
      _onComplete = fn;
    },
    get done() {
      return done;
    },
  };
}

// ---------------------------------------------------------------------------
// Sequence — run clips one after another.
// ---------------------------------------------------------------------------

/** Chain clips so they play sequentially. Accepts plain clips or nested
 *  parallel() groups. onComplete fires when the last clip finishes. */
export function sequence(clips) {
  let idx = 0;
  let done = false;
  let _onComplete = null;

  function update(dt) {
    if (done) return true;
    while (idx < clips.length) {
      const finished = clips[idx].update(dt);
      if (!finished) return false;
      idx += 1;
    }
    done = true;
    _onComplete?.();
    return true;
  }

  function reset() {
    idx = 0;
    done = false;
    for (const c of clips) c.reset();
  }

  return {
    update,
    reset,
    set onComplete(fn) {
      _onComplete = fn;
    },
    get done() {
      return done;
    },
  };
}

// ---------------------------------------------------------------------------
// Parallel — run clips simultaneously, finish when ALL are done.
// ---------------------------------------------------------------------------

/** Run an array of clips simultaneously. Finishes when every clip is done. */
export function parallel(clips) {
  let done = false;
  let _onComplete = null;

  function update(dt) {
    if (done) return true;
    let allDone = true;
    for (const c of clips) {
      if (!c.update(dt)) allDone = false;
    }
    if (allDone) {
      done = true;
      _onComplete?.();
    }
    return done;
  }

  function reset() {
    done = false;
    for (const c of clips) c.reset();
  }

  return {
    update,
    reset,
    set onComplete(fn) {
      _onComplete = fn;
    },
    get done() {
      return done;
    },
  };
}

// ---------------------------------------------------------------------------
// Delay — a no-op clip that waits `sec` seconds.
// ---------------------------------------------------------------------------

export function delay(sec) {
  let t = 0;
  let done = false;
  let _onComplete = null;
  return {
    update(dt) {
      if (done) return true;
      t += dt;
      if (t >= sec) {
        done = true;
        _onComplete?.();
      }
      return done;
    },
    reset() {
      t = 0;
      done = false;
    },
    set onComplete(fn) {
      _onComplete = fn;
    },
    get done() {
      return done;
    },
  };
}

// ---------------------------------------------------------------------------
// Timeline — a managed list of clips you push into and update each frame.
// ---------------------------------------------------------------------------

/** A running playlist. Push clips/sequences in at any time; they run and are
 *  removed when done so you never accumulate stale state. */
export function createTimeline() {
  const active = [];

  function update(dt) {
    for (let i = active.length - 1; i >= 0; i--) {
      const done = active[i].update(dt);
      if (done) active.splice(i, 1);
    }
  }

  function play(clipOrSeq) {
    active.push(clipOrSeq);
  }

  function clear() {
    active.length = 0;
  }

  function getState() {
    return { activeClips: active.length };
  }

  return { update, play, clear, getState };
}

// ---------------------------------------------------------------------------
// Helpers — squash/flash: one-liners for hit reactions.
// ---------------------------------------------------------------------------

/** Squash-and-stretch pop on `obj`: squash on X/Z, stretch on Y, then spring
 *  back. Pushes directly into `timeline`. duration in seconds (default 0.35). */
export function squashPop(obj, timeline, opts = {}) {
  const dur = opts.duration ?? 0.35;
  const sqX = opts.squashX ?? 1.4;
  const sqY = opts.squashY ?? 0.65;
  const origScale = obj.scale.clone();
  const squashed = new THREE.Vector3(origScale.x * sqX, origScale.y * sqY, origScale.z * sqX);
  const seq = sequence([
    clip(obj, { scale: squashed }, dur * 0.35, Easing.easeOut),
    clip(obj, { scale: origScale }, dur * 0.65, Easing.bounce),
  ]);
  timeline.play(seq);
  return seq;
}

/** Flash the material emissive to `colorHex` and fade back. Requires a
 *  MeshStandardMaterial (or compatible) on obj. */
export function emissiveFlash(obj, timeline, colorHex = 0xffffff, opts = {}) {
  const dur = opts.duration ?? 0.3;
  const mat = obj.material;
  if (!mat?.emissive) return null;
  const origHex = mat.emissive.getHex();
  const flashColor = new THREE.Color(colorHex);
  const origColor = new THREE.Color(origHex);
  let t = 0;
  let done = false;
  let _onComplete = null;
  const flashClip = {
    update(dt) {
      if (done) return true;
      t += dt;
      const k = Math.min(t / dur, 1);
      mat.emissive.lerpColors(flashColor, origColor, k);
      if (k >= 1) {
        done = true;
        _onComplete?.();
      }
      return done;
    },
    reset() {
      t = 0;
      done = false;
      mat.emissive.setHex(origHex);
    },
    set onComplete(fn) {
      _onComplete = fn;
    },
    get done() {
      return done;
    },
  };
  mat.emissive.copy(flashColor);
  timeline.play(flashClip);
  return flashClip;
}

// Usage:
//   import { createTimeline, clip, sequence, parallel, delay,
//            squashPop, emissiveFlash, Easing } from './animation-sequencer.jsx';
//   import * as THREE from 'three';
//
//   const tl = createTimeline();
//
//   // Move a mesh to a target pos then rotate it, chained:
//   const moveSeq = sequence([
//     clip(mesh, { position: new THREE.Vector3(0, 2, 0) }, 0.4, Easing.easeOut),
//     delay(0.1),
//     clip(mesh, { rotation: new THREE.Vector3(0, Math.PI, 0) }, 0.3),
//   ]);
//   moveSeq.onComplete = () => console.log('done');
//   tl.play(moveSeq);
//
//   // On enemy hit — squash pop + white flash simultaneously:
//   function onHit(enemy) {
//     squashPop(enemy, tl);
//     emissiveFlash(enemy, tl, 0xffffff, { duration: 0.25 });
//   }
//
//   function onUpdate(dt) {
//     tl.update(dt);   // call once per frame
//   }
//   window.__game.debug.snapshot = () => tl.getState();
//   // => { activeClips: 2 }
