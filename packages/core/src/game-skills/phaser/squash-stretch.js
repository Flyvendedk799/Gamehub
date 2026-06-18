// when_to_use: Phaser squash & stretch — the classic animation principle that
// makes sprites feel alive and elastic. Squash on landing/impact, stretch on
// jump/launch, a quick pop on spawn/pickup. One tween, applied to any sprite
// with a `.setScale`. Cheap, reads instantly, and is the difference between a
// rigid sprite and one with weight. Anchor matters: set the sprite origin to
// (0.5, 1) so a landing squash plants its feet instead of floating.

import Phaser from 'phaser';

/** Squash (wide + short) then spring back. Call on landing / hard hit. */
export function squash(scene, sprite, amount = 0.25, ms = 130) {
  sprite._feelBaseX ??= sprite.scaleX;
  sprite._feelBaseY ??= sprite.scaleY;
  const bx = sprite._feelBaseX;
  const by = sprite._feelBaseY;
  scene.tweens.killTweensOf(sprite);
  scene.tweens.add({
    targets: sprite,
    scaleX: bx * (1 + amount),
    scaleY: by * (1 - amount),
    duration: ms * 0.4,
    yoyo: true,
    ease: 'Quad.easeOut',
    onComplete: () => sprite.setScale(bx, by),
  });
}

/** Stretch (tall + thin) then spring back. Call on jump / launch / dash. */
export function stretch(scene, sprite, amount = 0.22, ms = 150) {
  sprite._feelBaseX ??= sprite.scaleX;
  sprite._feelBaseY ??= sprite.scaleY;
  const bx = sprite._feelBaseX;
  const by = sprite._feelBaseY;
  scene.tweens.killTweensOf(sprite);
  scene.tweens.add({
    targets: sprite,
    scaleX: bx * (1 - amount),
    scaleY: by * (1 + amount),
    duration: ms * 0.4,
    yoyo: true,
    ease: 'Quad.easeOut',
    onComplete: () => sprite.setScale(bx, by),
  });
}

/** Pop — a quick overshoot-and-settle on spawn or pickup. Uses Back ease for
 *  the satisfying bounce. */
export function popIn(scene, sprite, ms = 220) {
  sprite._feelBaseX ??= sprite.scaleX;
  sprite._feelBaseY ??= sprite.scaleY;
  const bx = sprite._feelBaseX;
  const by = sprite._feelBaseY;
  sprite.setScale(bx * 0.1, by * 0.1);
  scene.tweens.add({
    targets: sprite,
    scaleX: bx,
    scaleY: by,
    duration: ms,
    ease: 'Back.easeOut',
  });
}

// Usage:
//   import { squash, stretch, popIn } from './feel/squash-stretch.js';
//   // sprite.setOrigin(0.5, 1) so squash plants the feet
//   onLand()  { squash(this, this.player); }
//   onJump()  { stretch(this, this.player); }
//   onSpawn(e){ popIn(this, e); }
