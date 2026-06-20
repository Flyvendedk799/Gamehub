// when_to_use: Phaser enemy AI — reusable, framerate-independent behaviors for
// arcade-physics enemy sprites so generated games stop re-deriving (badly) the
// same chase/patrol/strafe/charge/kite logic. Each behavior reads the TARGET
// position and writes the enemy body velocity + a tiny state machine on
// enemy._ai. Aggressive moves (chargeAndRetreat) TELEGRAPH with a visible
// windup (tint + scale) before they commit — that is the anti-slop point: the
// player can always read and dodge the attack. Use makeEnemyBrain(kind) to get
// the matching per-frame update fn. Every enemy sprite needs an arcade body
// (scene.physics.add.existing(enemy) or a physics group).

import * as Phaser from 'phaser';

/** Lazily create the per-enemy AI state bag. Holds the mini state machine
 *  (phase/timers) used by the stateful behaviors. Safe to call every frame. */
function ai(enemy) {
  if (!enemy._ai) enemy._ai = { phase: 'idle', t: 0, wp: 0, dir: 1, fireT: 0 };
  return enemy._ai;
}

/** Seek `target` at opts.speed, easing to a stop inside opts.arriveRadius so
 *  the enemy settles ON the player instead of jittering back and forth across
 *  it. dt is seconds (pass scene delta/1000) — only used to age timers, the
 *  velocity itself is px/sec so it is already framerate-independent. */
export function chasePlayer(enemy, target, opts = {}) {
  const body = enemy.body;
  if (!body) return;
  const speed = opts.speed ?? 90;
  const arrive = opts.arriveRadius ?? 24;
  const dx = target.x - enemy.x;
  const dy = target.y - enemy.y;
  const dist = Math.hypot(dx, dy) || 1;
  // Inside the arrive radius, scale speed down linearly to kill jitter.
  const scale = dist < arrive ? dist / arrive : 1;
  body.setVelocity((dx / dist) * speed * scale, (dy / dist) * speed * scale);
}

/** Walk a loop of opts.points [{x,y}, ...], advancing to the next waypoint
 *  once within opts.threshold. opts.mode 'loop' wraps; 'pingpong' reverses at
 *  the ends. State lives on enemy._ai.wp / .dir. */
export function patrolWaypoints(enemy, opts = {}) {
  const body = enemy.body;
  const pts = opts.points;
  if (!body || !pts || pts.length === 0) return;
  const s = ai(enemy);
  const speed = opts.speed ?? 70;
  const threshold = opts.threshold ?? 6;
  const goal = pts[s.wp];
  const dx = goal.x - enemy.x;
  const dy = goal.y - enemy.y;
  const dist = Math.hypot(dx, dy) || 1;
  if (dist <= threshold) {
    if ((opts.mode ?? 'loop') === 'pingpong') {
      if (s.wp + s.dir >= pts.length || s.wp + s.dir < 0) s.dir *= -1;
      s.wp += s.dir;
    } else {
      s.wp = (s.wp + 1) % pts.length;
    }
    return;
  }
  body.setVelocity((dx / dist) * speed, (dy / dist) * speed);
}

/** Circle `target` at opts.radius (a "shark" orbit). Pulls in/out to hold the
 *  ring, then adds a tangential velocity (opts.clockwise flips direction).
 *  Great for ranged or harassment enemies that never sit still. */
export function strafeOrbit(enemy, target, opts = {}) {
  const body = enemy.body;
  if (!body) return;
  const radius = opts.radius ?? 140;
  const speed = opts.speed ?? 80;
  const dx = enemy.x - target.x;
  const dy = enemy.y - target.y;
  const dist = Math.hypot(dx, dy) || 1;
  // Radial correction: positive = too far (move in), negative = too close.
  const radial = (dist - radius) / radius; // ~ -1..1 near the ring
  const rx = -(dx / dist) * radial; // toward target when too far
  const ry = -(dy / dist) * radial;
  // Tangent (perpendicular to the radius) for the circling motion.
  const sign = opts.clockwise ? -1 : 1;
  const tx = (-dy / dist) * sign;
  const ty = (dx / dist) * sign;
  body.setVelocity((rx + tx) * speed, (ry + ty) * speed);
}

/** Telegraphed charger: holds, flashes a WINDUP (tint + scale-up) the player
 *  can read, then dashes straight at where the target was, then retreats and
 *  cools down before repeating. State machine on enemy._ai.phase:
 *  approach -> windup -> dash -> retreat -> approach. dt in seconds. */
export function chargeAndRetreat(enemy, target, opts = {}) {
  const body = enemy.body;
  if (!body) return;
  const s = ai(enemy);
  const dt = opts.dt ?? 0.016;
  const speed = opts.speed ?? 70;
  const dashSpeed = opts.dashSpeed ?? 320;
  const triggerRange = opts.triggerRange ?? 180;
  const windupMs = opts.windupMs ?? 450; // visible tell — keep it generous
  const dashMs = opts.dashMs ?? 280;
  const retreatMs = opts.retreatMs ?? 600;
  const tint = opts.windupTint ?? 0xff5544;
  s.t += dt * 1000;

  const dx = target.x - enemy.x;
  const dy = target.y - enemy.y;
  const dist = Math.hypot(dx, dy) || 1;

  if (s.phase === 'idle' || s.phase === 'approach') {
    s.phase = 'approach';
    body.setVelocity((dx / dist) * speed, (dy / dist) * speed);
    if (dist <= triggerRange) {
      s.phase = 'windup';
      s.t = 0;
      enemy.setTint(tint); // TELEGRAPH: turn red...
    }
  } else if (s.phase === 'windup') {
    body.setVelocity(0, 0);
    // ...and swell so the dash is unmistakably about to happen.
    const k = Math.min(s.t / windupMs, 1);
    enemy.setScale(1 + 0.25 * k);
    if (s.t >= windupMs) {
      s.phase = 'dash';
      s.t = 0;
      s.dvx = (dx / dist) * dashSpeed; // lock in aim at fire time
      s.dvy = (dy / dist) * dashSpeed;
    }
  } else if (s.phase === 'dash') {
    body.setVelocity(s.dvx, s.dvy);
    if (s.t >= dashMs) {
      s.phase = 'retreat';
      s.t = 0;
      enemy.clearTint();
      enemy.setScale(1);
    }
  } else if (s.phase === 'retreat') {
    body.setVelocity((-dx / dist) * speed, (-dy / dist) * speed);
    if (s.t >= retreatMs) {
      s.phase = 'approach';
      s.t = 0;
    }
  }
}

/** Ranged kiter: holds opts.preferredRange, backs off when the target gets
 *  closer than opts.minRange, advances when beyond preferredRange, and calls
 *  opts.onFire(enemy, target) every opts.fireMs while roughly in range. dt in
 *  seconds. opts.onFire is where you spawn the projectile (telegraph it!). */
export function rangedKite(enemy, target, opts = {}) {
  const body = enemy.body;
  if (!body) return;
  const s = ai(enemy);
  const dt = opts.dt ?? 0.016;
  const speed = opts.speed ?? 85;
  const preferred = opts.preferredRange ?? 200;
  const minRange = opts.minRange ?? 120;
  const fireMs = opts.fireMs ?? 1200;
  const dx = target.x - enemy.x;
  const dy = target.y - enemy.y;
  const dist = Math.hypot(dx, dy) || 1;

  if (dist < minRange) {
    body.setVelocity((-dx / dist) * speed, (-dy / dist) * speed); // flee
  } else if (dist > preferred) {
    body.setVelocity((dx / dist) * speed, (dy / dist) * speed); // close in
  } else {
    body.setVelocity(0, 0); // hold the sweet spot and shoot
  }

  s.fireT += dt * 1000;
  if (dist <= preferred + 40 && s.fireT >= fireMs) {
    s.fireT = 0;
    if (typeof opts.onFire === 'function') opts.onFire(enemy, target);
  }
}

/** Return the per-frame update fn for a behavior `kind`. Call the returned fn
 *  with (enemy, target, opts) every frame. Unknown kinds fall back to chase. */
export function makeEnemyBrain(kind) {
  switch (kind) {
    case 'patrol':
      return (enemy, _target, opts) => patrolWaypoints(enemy, opts);
    case 'orbit':
      return strafeOrbit;
    case 'charger':
      return chargeAndRetreat;
    case 'kite':
      return rangedKite;
    default:
      return chasePlayer;
  }
}

// Usage:
//   import { makeEnemyBrain } from './engine/enemy-ai.js';
//   // create(): give the enemy an arcade body, attach a brain.
//   const enemy = this.physics.add.sprite(x, y, 'enemy');
//   enemy._brain = makeEnemyBrain('charger');
//   // update(time, delta): drive every enemy from the player position.
//   const dt = delta / 1000;
//   this.enemies.children.iterate((e) => {
//     if (e._stunned) return; // respects knockback.js stagger
//     e._brain(e, this.player, { dt, speed: 90, triggerRange: 200 });
//   });
//
//   // Surface AI/alive state for playtests so escalation is verifiable:
//   //   window.__game.debug.snapshot = () => ({
//   //     alive: this.enemies.countActive(true),
//   //     phases: this.enemies.getChildren().map((e) => e._ai?.phase),
//   //   });
