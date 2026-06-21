// when_to_use: Phaser tween/keyframe sequencer for juicy animations — reach
// for this when state transitions, boss intros, hit reactions, or cutscene-lite
// moments need more than a single tween. createTimeline chains steps (tween,
// delay, callback) sequentially; parallel() runs multiple tweens at once and
// waits for ALL to finish; spriteFlash and squashStretch are one-shot juice
// helpers that layer on top. Call sequencer.play() from create() or event
// handlers; it resolves a promise so you can await it in async scene methods.

import * as Phaser from 'phaser';

/**
 * A small sequential timeline built on top of Phaser's tween manager.
 *
 * Usage: createTimeline(scene).tween(target, props).wait(300).call(fn).play()
 *
 * Each .tween() call accepts any Phaser TweenBuilderConfig properties
 * (duration, ease, x, y, alpha, scaleX, scaleY, …).
 * Returns the builder (chainable) until .play() is called.
 * .play() returns a Promise that resolves when the last step finishes.
 */
export function createTimeline(scene) {
  const steps = [];

  const builder = {
    /** Add a tween step on `target` (sprite/image/text/camera/…). */
    tween(target, props = {}) {
      steps.push({ type: 'tween', target, props });
      return builder;
    },
    /** Add steps that run in parallel — all finish before the next step. */
    parallel(tweenDefs = []) {
      // tweenDefs: [{target, props}, ...]
      steps.push({ type: 'parallel', tweenDefs });
      return builder;
    },
    /** Pause for `ms` milliseconds. */
    wait(ms) {
      steps.push({ type: 'wait', ms });
      return builder;
    },
    /** Call a synchronous function (state mutation, sound, etc.). */
    call(fn) {
      steps.push({ type: 'call', fn });
      return builder;
    },
    /** Execute the timeline. Returns a Promise that resolves on completion. */
    play() {
      return new Promise((resolve) => {
        let idx = 0;

        function next() {
          if (idx >= steps.length) {
            resolve();
            return;
          }
          const step = steps[idx++];

          if (step.type === 'tween') {
            scene.tweens.add({
              targets: step.target,
              ...step.props,
              onComplete: next,
            });
          } else if (step.type === 'parallel') {
            let remaining = step.tweenDefs.length;
            if (remaining === 0) {
              next();
              return;
            }
            for (const def of step.tweenDefs) {
              scene.tweens.add({
                targets: def.target,
                ...def.props,
                onComplete: () => {
                  remaining -= 1;
                  if (remaining === 0) next();
                },
              });
            }
          } else if (step.type === 'wait') {
            scene.time.delayedCall(step.ms, next);
          } else if (step.type === 'call') {
            step.fn();
            next();
          }
        }

        next();
      });
    },
  };

  return builder;
}

/**
 * Flash a sprite to a tint color and back `count` times.
 * Great for invincibility frames, hit confirmation, and warning pulses.
 * Returns a Promise that resolves when the flash sequence is done.
 */
export function spriteFlash(scene, sprite, opts = {}) {
  const color = opts.color ?? 0xffffff;
  const count = opts.count ?? 3;
  const halfMs = opts.halfMs ?? 60; // time on each half-cycle
  // Preserve the sprite's ORIGINAL tint state. On an untinted sprite tintTopLeft
  // is 0xffffff, so restoring via setTint(originalTint) would leave it stuck
  // solid white — restore by clearing instead when it was never tinted.
  const wasTinted = sprite.isTinted;
  const originalTint = sprite.tintTopLeft;

  return new Promise((resolve) => {
    let flashes = 0;
    function flash() {
      if (flashes >= count * 2) {
        if (wasTinted) sprite.setTint(originalTint);
        else sprite.clearTint();
        resolve();
        return;
      }
      if (flashes % 2 === 0) {
        sprite.setTint(color);
      } else {
        sprite.clearTint();
      }
      flashes += 1;
      scene.time.delayedCall(halfMs, flash);
    }
    flash();
  });
}

/**
 * Squash-and-stretch: squash down then spring back to natural scale.
 * Use on landing, impact, or spawn to add physicality.
 * opts: scaleX, scaleY, duration (ms), ease — all optional.
 */
export function squashStretch(scene, sprite, opts = {}) {
  const sx = opts.scaleX ?? 1.4;
  const sy = opts.scaleY ?? 0.6;
  const dur = opts.duration ?? 200;
  const ease = opts.ease ?? 'Bounce.easeOut';
  const ox = sprite.scaleX;
  const oy = sprite.scaleY;

  return new Promise((resolve) => {
    createTimeline(scene)
      .tween(sprite, { scaleX: sx, scaleY: sy, duration: dur * 0.35, ease: 'Quad.easeOut' })
      .tween(sprite, { scaleX: ox, scaleY: oy, duration: dur * 0.65, ease })
      .call(resolve)
      .play();
  });
}

/**
 * Convenience: bounce-in entrance for a sprite (scale from 0 to natural size).
 * Call once in create() for UI elements or enemy spawns.
 */
export function bounceIn(scene, sprite, durationMs = 400) {
  const tx = sprite.scaleX;
  const ty = sprite.scaleY;
  sprite.setScale(0);
  return new Promise((resolve) => {
    scene.tweens.add({
      targets: sprite,
      scaleX: tx,
      scaleY: ty,
      duration: durationMs,
      ease: 'Back.easeOut',
      onComplete: resolve,
    });
  });
}

// Usage:
//   import { createTimeline, spriteFlash, squashStretch, bounceIn }
//     from './engine/animation-sequencer.js';
//
//   // Boss intro (async scene method):
//   async bossEntrance(boss) {
//     boss.setAlpha(0).setScale(0);
//     await createTimeline(this)
//       .wait(500)
//       .parallel([
//         { target: boss, props: { alpha: 1, duration: 400, ease: 'Sine.easeIn' } },
//         { target: boss, props: { scaleX: 1, scaleY: 1, duration: 500, ease: 'Back.easeOut' } },
//       ])
//       .call(() => this.cameras.main.shake(200, 0.01))
//       .wait(300)
//       .play();
//     this.startBossFight();
//   }
//
//   // Hit feedback:
//   onPlayerHit(player) {
//     spriteFlash(this, player, { color: 0xff0000, count: 4, halfMs: 80 });
//   }
//
//   // Landing:
//   onPlayerLand(player) {
//     squashStretch(this, player, { scaleX: 1.3, scaleY: 0.7, duration: 220 });
//   }
//
//   //   window.__game.debug.snapshot = () => ({ tweensActive: this.tweens.getTweens().length });
