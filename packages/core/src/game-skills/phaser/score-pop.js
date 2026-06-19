// when_to_use: Phaser floating score / damage numbers ("+100", "-25", "PERFECT!")
// that rise and fade at the point of action. The cheapest way to make scoring
// feel rewarding and to communicate damage in combat. Also covers a punchy
// HUD score-counter "pop" (scale bump) when the running total changes, so the
// score readout itself reacts instead of silently ticking.

import * as Phaser from 'phaser';

/** Spawn a floating text that drifts up and fades, then auto-destroys.
 *  Place at the world position of the event (enemy.x/y, coin.x/y). */
export function floatingText(scene, x, y, text, opts = {}) {
  const label = scene.add
    .text(x, y, String(text), {
      fontFamily: opts.font ?? 'monospace',
      fontSize: `${opts.size ?? 20}px`,
      color: opts.color ?? '#ffffff',
      stroke: '#000000',
      strokeThickness: opts.stroke ?? 4,
    })
    .setOrigin(0.5, 1)
    .setDepth(opts.depth ?? 9999);
  scene.tweens.add({
    targets: label,
    y: y - (opts.rise ?? 48),
    alpha: { from: 1, to: 0 },
    scale: { from: opts.pop ?? 1.3, to: 1 },
    duration: opts.duration ?? 700,
    ease: 'Cubic.easeOut',
    onComplete: () => label.destroy(),
  });
  return label;
}

/** Pop the HUD score label when the total changes — a quick scale bump back
 *  to 1. Pass your persistent score Text object. */
export function scorePop(scene, scoreText, scale = 1.35, ms = 160) {
  scene.tweens.killTweensOf(scoreText);
  scoreText.setScale(scale);
  scene.tweens.add({
    targets: scoreText,
    scale: 1,
    duration: ms,
    ease: 'Back.easeOut',
  });
}

// Usage:
//   import { floatingText, scorePop } from './feel/score-pop.js';
//   onEnemyHit(e, dmg) {
//     floatingText(this, e.x, e.y - 20, `-${dmg}`, { color: '#ff5a5a' });
//   }
//   addScore(n, enemy) {
//     this.score += n;
//     this.scoreText.setText(`Score: ${this.score}`);
//     scorePop(this, this.scoreText);
//     floatingText(this, enemy.x, enemy.y, `+${n}`, { color: '#ffd166' });
//   }
