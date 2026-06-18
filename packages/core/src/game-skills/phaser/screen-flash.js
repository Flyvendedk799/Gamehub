// when_to_use: Phaser full-screen flash / tint — a brief color wash over the
// whole view for big moments: white on heavy hit, red when the PLAYER takes
// damage, yellow on a power-up, black-out on death. Phaser's camera has
// `flash()` (white-ish quick fade) and `fade()` built in; this wraps them
// with damage/heal/death presets and an arbitrary-color variant. Use
// SPARINGLY and BRIEFLY — a 120ms red vignette on player-hit is great; a
// flash on every minor tick is nauseating.

import Phaser from 'phaser';

const FLASH_PRESETS = {
  damage: { r: 255, g: 40, b: 40, duration: 160 }, // player took a hit
  heal: { r: 80, g: 255, b: 120, duration: 220 },
  powerup: { r: 255, g: 220, b: 80, duration: 220 },
  hitConfirm: { r: 255, g: 255, b: 255, duration: 60 }, // brief white on landing a hit
};

/** Quick full-screen color flash via the camera. `event` picks a preset, or
 *  pass `{ r, g, b, duration }`. Non-blocking; clears itself. */
export function screenFlash(scene, event = 'hitConfirm', override = {}) {
  const p = FLASH_PRESETS[event] ?? FLASH_PRESETS.hitConfirm;
  const r = override.r ?? p.r;
  const g = override.g ?? p.g;
  const b = override.b ?? p.b;
  const duration = override.duration ?? p.duration;
  // force = true so rapid hits each register their own flash.
  scene.cameras.main.flash(duration, r, g, b, true);
}

/** Fade the camera to black (death / scene exit). Listen via the camera's
 *  `camerafadeoutcomplete` event to trigger a restart or scene swap. */
export function fadeOut(scene, ms, onDone) {
  const dur = ms ?? 500;
  scene.cameras.main.fadeOut(dur, 0, 0, 0);
  if (onDone) {
    scene.cameras.main.once('camerafadeoutcomplete', onDone);
  }
}

// Usage:
//   import { screenFlash, fadeOut } from './feel/screen-flash.js';
//   onPlayerHurt() { screenFlash(this, 'damage'); }
//   onLandHit()    { screenFlash(this, 'hitConfirm'); }
//   onPlayerDeath(){ fadeOut(this, 600, () => this.scene.restart()); }
