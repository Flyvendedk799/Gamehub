// when_to_use: Phaser knockback — shove a body away from an impact so hits
// physically move things. The companion to screen-shake/hitstop: shake says
// "the camera felt it", knockback says "the TARGET felt it". Works on any
// arcade-physics body. Includes a brief input-lock helper so the player
// can't instantly cancel their own knockback (key for brawler weight) and a
// hit-flash tint so the struck sprite blinks white on contact.

import * as Phaser from 'phaser';

/** Apply an impulse to `target` directed away from `source` (or along an
 *  explicit angle). Requires arcade physics. `power` is px/sec. */
export function knockback(target, source, power = 260, opts = {}) {
  const body = target.body;
  if (!body) return;
  let dx;
  let dy;
  if (opts.angle !== undefined) {
    dx = Math.cos(opts.angle);
    dy = Math.sin(opts.angle);
  } else {
    dx = target.x - source.x;
    dy = target.y - source.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
  }
  body.setVelocity(dx * power, dy * power - (opts.lift ?? 0));
}

/** Lock a sprite's control input for `ms` (stagger). Pair with knockback so
 *  the struck actor is briefly helpless. Sets/clears `sprite._stunned`;
 *  check it at the top of your controller's update. */
export function stun(scene, sprite, ms = 180) {
  sprite._stunned = true;
  scene.time.delayedCall(ms, () => {
    sprite._stunned = false;
  });
}

/** Blink the struck sprite white for a couple frames — instant "I hit it"
 *  confirmation, even before any particle/sound lands. */
export function hitFlash(scene, sprite, ms = 80) {
  sprite.setTintFill(0xffffff);
  scene.time.delayedCall(ms, () => sprite.clearTint());
}

// Usage:
//   import { knockback, stun, hitFlash } from './feel/knockback.js';
//   onEnemyHit(enemy, attacker, dmg) {
//     knockback(enemy, attacker, 280, { lift: 120 });
//     stun(this, enemy, 200);
//     hitFlash(this, enemy);
//   }
//   // in the enemy controller's update():
//   //   if (this.sprite._stunned) return; // skip AI/movement while staggered
