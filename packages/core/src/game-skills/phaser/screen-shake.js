// when_to_use: Phaser camera screen-shake — the #1 impact primitive. Fire a
// SHORT, SMALL shake on every hit / explosion / hard landing / death so the
// game reads as physical instead of flat. Keep amplitude tiny (≤ 0.006 = a
// few px); big shakes feel cheap and break readability. Phaser ships
// `camera.shake()` natively, so this is a thin tuned wrapper with sane
// duration/intensity presets per event type.

import * as Phaser from 'phaser';

/** Preset intensities keyed by event. `intensity` is Phaser's normalized
 *  shake amount (fraction of viewport), NOT pixels. 0.004 ≈ 3px on a 720p
 *  canvas — already plenty for a hit. Tune UP only for big set-pieces. */
const SHAKE_PRESETS = {
  hit: { duration: 90, intensity: 0.004 },
  heavyHit: { duration: 140, intensity: 0.008 },
  explosion: { duration: 260, intensity: 0.012 },
  land: { duration: 70, intensity: 0.003 },
  death: { duration: 350, intensity: 0.014 },
};

/** Shake the scene's main camera. `event` picks a preset; pass an explicit
 *  `{ duration, intensity }` to override. Force-restarts an in-flight shake
 *  so rapid hits stay punchy instead of being swallowed. */
export function screenShake(scene, event = 'hit', override = {}) {
  const preset = SHAKE_PRESETS[event] ?? SHAKE_PRESETS.hit;
  const duration = override.duration ?? preset.duration;
  const intensity = override.intensity ?? preset.intensity;
  // 4th arg `force = true` re-triggers even if a shake is already running —
  // critical for combo hits, otherwise the second punch feels dead.
  scene.cameras.main.shake(duration, intensity, true);
}

/** Directional kick — biases the shake along a vector so a hit from the
 *  right shoves the camera left. Subtler and more "felt" than pure noise.
 *  `dirX/dirY` are -1..1; `power` in px. Pairs well with knockback. */
export function cameraKick(scene, dirX = 0, dirY = -1, power = 6) {
  const cam = scene.cameras.main;
  const len = Math.hypot(dirX, dirY) || 1;
  const ox = (dirX / len) * power;
  const oy = (dirY / len) * power;
  scene.tweens.add({
    targets: cam,
    scrollX: cam.scrollX + ox,
    scrollY: cam.scrollY + oy,
    duration: 50,
    yoyo: true,
    ease: 'Quad.easeOut',
  });
}

// Usage:
//   import { screenShake, cameraKick } from './feel/screen-shake.js';
//   onPlayerHit(dmg) {
//     screenShake(this, dmg > 30 ? 'heavyHit' : 'hit');
//     cameraKick(this, this.player.flipX ? 1 : -1, 0, 5);
//   }
//   onEnemyExplode() { screenShake(this, 'explosion'); }
