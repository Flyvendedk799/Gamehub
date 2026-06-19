// when_to_use: Phaser particle burst — a short spray of particles at an
// impact point (hit spark, coin pickup, dust on landing, death pop). Uses
// Phaser 3.60+ `scene.add.particles(x, y, texture, config)` with
// `explode()` for a one-shot burst. If you have no particle texture, the
// `makePixelTexture` helper bakes a 1x1 white pixel you can tint per-burst,
// so a burst works with ZERO art assets.

import * as Phaser from 'phaser';

/** Bake a tiny white square texture once, reuse for every tinted burst.
 *  Call in create() before the first burst. Safe to call repeatedly. */
export function makePixelTexture(scene, key = 'feel_pixel', size = 4) {
  if (scene.textures.exists(key)) return key;
  const g = scene.make.graphics({ x: 0, y: 0, add: false });
  g.fillStyle(0xffffff, 1);
  g.fillRect(0, 0, size, size);
  g.generateTexture(key, size, size);
  g.destroy();
  return key;
}

/** One-shot burst at (x, y). Particles fly outward, shrink and fade, then
 *  the emitter self-destroys — no manual cleanup, no leak across many hits.
 *  `tint` colors the spark (0xffd166 = gold pickup, 0xff4d4d = damage). */
export function particleBurst(scene, x, y, opts = {}) {
  const key = opts.texture ?? makePixelTexture(scene);
  const count = opts.count ?? 12;
  const emitter = scene.add.particles(x, y, key, {
    speed: opts.speed ?? { min: 60, max: 180 },
    angle: opts.angle ?? { min: 0, max: 360 },
    scale: { start: opts.scale ?? 1.2, end: 0 },
    lifespan: opts.lifespan ?? 380,
    tint: opts.tint ?? 0xffffff,
    blendMode: opts.blend ?? 'ADD',
    gravityY: opts.gravityY ?? 0,
    quantity: count,
    emitting: false, // explode-only
  });
  emitter.explode(count, x, y);
  // Self-clean after the longest particle dies.
  scene.time.delayedCall((opts.lifespan ?? 380) + 60, () => emitter.destroy());
  return emitter;
}

// Usage:
//   import { particleBurst } from './feel/particle-burst.js';
//   create() { /* nothing to preload — texture is baked on first burst */ }
//   onCoinPickup(coin) {
//     particleBurst(this, coin.x, coin.y, { tint: 0xffd166, count: 14 });
//   }
//   onEnemyHit(e) {
//     particleBurst(this, e.x, e.y, { tint: 0xff4d4d, speed: { min: 80, max: 240 } });
//   }
