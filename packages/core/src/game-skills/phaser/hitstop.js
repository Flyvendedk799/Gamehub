// when_to_use: Phaser hitstop / freeze-frame — pause the action for a few
// frames on impact so the hit "lands" with weight. This is the single
// highest-leverage feel primitive for any game with attacks (brawler,
// platformer stomp, shmup kill). Without it, hits feel like the target
// passes through; with it, every connection has a tiny satisfying hitch.
// Genre-aware feel checks (assert_game_invariants) flag a `fighting` game
// that ships no hitstop.

/** Freeze gameplay for `ms` by halting all animations, tweens and physics,
 *  then resume. Uses a SEPARATE delayedCall on a paused-immune clock path so
 *  the resume always fires. Stack-safe: a second hit during the freeze
 *  extends rather than double-resumes. */
export function hitstop(scene, ms = 70) {
  // Track depth so overlapping hits don't resume early.
  scene._hitstopDepth = (scene._hitstopDepth ?? 0) + 1;
  if (scene._hitstopDepth === 1) {
    scene.anims.pauseAll();
    if (scene.physics?.world) scene.physics.world.isPaused = true;
    // Pause the tween manager too so movement/scale tweens hold the frame.
    scene.tweens.pauseAll();
  }
  // setTimeout runs on the browser clock, immune to the paused game clock —
  // guarantees the unfreeze even though Phaser timers are halted.
  window.setTimeout(() => {
    scene._hitstopDepth = Math.max(0, (scene._hitstopDepth ?? 1) - 1);
    if (scene._hitstopDepth === 0) {
      scene.anims.resumeAll();
      if (scene.physics?.world) scene.physics.world.isPaused = false;
      scene.tweens.resumeAll();
    }
  }, ms);
}

/** Time-dilation variant — slow-mo instead of hard freeze. Use for a boss
 *  kill or a perfect-parry flourish. Restores after `ms` real milliseconds. */
export function slowMo(scene, factor = 0.25, ms = 220) {
  scene.time.timeScale = factor;
  if (scene.physics?.world) scene.physics.world.timeScale = 1 / factor;
  window.setTimeout(() => {
    scene.time.timeScale = 1;
    if (scene.physics?.world) scene.physics.world.timeScale = 1;
  }, ms);
}

// Usage:
//   import { hitstop, slowMo } from './feel/hitstop.js';
//   onHit(attacker, target) {
//     hitstop(this, 70);              // light hit
//     // heavy/finisher:
//     // hitstop(this, 120);
//   }
//   onBossDefeated() { slowMo(this, 0.2, 400); }
