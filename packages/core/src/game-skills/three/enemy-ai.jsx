// when_to_use: Three.js enemy behaviors — reusable, dt-scaled movement brains
// for THREE.Object3D enemies. Reach for this instead of re-deriving chase/
// patrol/orbit/charge/kite math per game. These operate on positions via
// vector math (NOT physics bodies): you call one per enemy per frame and it
// mutates enemy.position (and rotation, if facing). Aggressive moves
// (chargeAndRetreat) TELEGRAPH with a visible windup so the player can react —
// that is the anti-slop point. State lives on enemy.userData.ai.

import * as THREE from 'three';

// Module-scope scratch vectors — reused every frame to avoid per-tick allocs.
const _to = new THREE.Vector3();
const _step = new THREE.Vector3();
const _tangent = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/** Move `enemy` toward `targetPos` at opts.speed units/sec, easing to a stop
 *  inside opts.arriveRadius so it doesn't jitter on top of the player. Set
 *  opts.face to rotate the enemy to look along its travel direction.
 *  Returns the planar distance to the target (handy for range checks). */
export function chasePlayer(enemy, targetPos, dt, opts = {}) {
  const speed = opts.speed ?? 4;
  const arriveRadius = opts.arriveRadius ?? 1.2;
  _to.subVectors(targetPos, enemy.position);
  if (opts.planar !== false) _to.y = 0;
  const dist = _to.length();
  if (dist > 1e-4) {
    _to.multiplyScalar(1 / dist); // normalize
    // Arrive: scale speed down linearly inside the slowdown ring.
    const ease = dist < arriveRadius ? dist / arriveRadius : 1;
    enemy.position.addScaledVector(_to, speed * ease * dt);
    if (opts.face) faceDir(enemy, _to);
  }
  return dist;
}

/** Walk `enemy` through opts.points (array of THREE.Vector3) in order, looping
 *  by default. Tracks progress on enemy.userData.ai.wp. opts.loop=false stops
 *  at the last point; opts.pingpong reverses at the ends. */
export function patrolWaypoints(enemy, dt, opts = {}) {
  const points = opts.points ?? [];
  if (points.length === 0) return;
  const ai = brainState(enemy);
  if (ai.wp === undefined) {
    ai.wp = 0;
    ai.wpDir = 1;
  }
  const speed = opts.speed ?? 3;
  const reach = opts.reachRadius ?? 0.4;
  const target = points[ai.wp];
  _to.subVectors(target, enemy.position);
  if (opts.planar !== false) _to.y = 0;
  const dist = _to.length();
  if (dist <= reach) {
    advanceWaypoint(ai, points.length, opts);
  } else {
    _step.copy(_to).multiplyScalar((speed * dt) / dist);
    enemy.position.add(_step);
    if (opts.face) faceDir(enemy, _to.normalize());
  }
}

/** Orbit `enemy` around `targetPos` on the xz-plane at opts.radius, drifting in
 *  to that radius if it's off it. opts.angularSpeed is radians/sec (sign sets
 *  spin direction). Good for shooters that circle-strafe the player. */
export function strafeOrbit(enemy, targetPos, dt, opts = {}) {
  const radius = opts.radius ?? 6;
  const angularSpeed = opts.angularSpeed ?? 1.2;
  const pull = opts.pull ?? 4; // how fast it corrects toward the ideal radius
  _to.subVectors(enemy.position, targetPos);
  _to.y = 0;
  const dist = _to.length() || 1e-4;
  // Tangent direction (perpendicular on xz) drives the orbit.
  _tangent.crossVectors(UP, _to).normalize();
  enemy.position.addScaledVector(_tangent, angularSpeed * radius * dt);
  // Radial correction toward the target radius.
  const radialErr = dist - radius;
  _to.multiplyScalar(1 / dist);
  enemy.position.addScaledVector(_to, -radialErr * Math.min(pull * dt, 1));
  if (opts.face) {
    _step.subVectors(targetPos, enemy.position);
    faceDir(enemy, _step);
  }
}

/** Telegraphed melee: idle → WINDUP (visible scale/emissive flare) → DASH
 *  through the player → RETREAT, then cooldown. The windup is the fair-warning
 *  window — keep telegraphSec high enough to dodge. State on userData.ai. */
export function chargeAndRetreat(enemy, targetPos, dt, opts = {}) {
  const ai = brainState(enemy);
  if (!ai.phase) ai.phase = 'idle';
  ai.t = (ai.t ?? 0) + dt;
  const telegraphSec = opts.telegraphSec ?? 0.7;
  const dashSpeed = opts.dashSpeed ?? 16;
  const dashSec = opts.dashSec ?? 0.35;
  const cooldownSec = opts.cooldownSec ?? 1.4;
  const triggerRange = opts.triggerRange ?? 8;

  switch (ai.phase) {
    case 'idle': {
      // Approach slowly until in range, then begin the telegraph.
      const dist = chasePlayer(enemy, targetPos, dt, {
        speed: opts.approachSpeed ?? 3,
        face: opts.face,
      });
      if (dist <= triggerRange) setPhase(enemy, ai, 'windup', opts);
      break;
    }
    case 'windup': {
      // Visible flare so the player can read the incoming dash.
      const k = Math.min(ai.t / telegraphSec, 1);
      applyTelegraph(enemy, ai, 1 + 0.35 * k, opts.telegraphColor ?? 0xff3b3b);
      if (ai.t >= telegraphSec) {
        _dashDir.subVectors(targetPos, enemy.position);
        _dashDir.y = 0;
        if (_dashDir.lengthSq() < 1e-6) _dashDir.set(0, 0, 1);
        _dashDir.normalize();
        ai.dashX = _dashDir.x;
        ai.dashZ = _dashDir.z;
        setPhase(enemy, ai, 'dash', opts);
      }
      break;
    }
    case 'dash': {
      _step.set(ai.dashX, 0, ai.dashZ);
      enemy.position.addScaledVector(_step, dashSpeed * dt);
      if (opts.face) faceDir(enemy, _step);
      if (ai.t >= dashSec) setPhase(enemy, ai, 'retreat', opts);
      break;
    }
    case 'retreat': {
      restoreTelegraph(enemy, ai);
      _to.subVectors(enemy.position, targetPos);
      _to.y = 0;
      if (_to.lengthSq() > 1e-6) {
        _to.normalize();
        enemy.position.addScaledVector(_to, (opts.retreatSpeed ?? 5) * dt);
      }
      if (ai.t >= cooldownSec) setPhase(enemy, ai, 'idle', opts);
      break;
    }
    default:
      break;
  }
  return ai.phase;
}

const _dashDir = new THREE.Vector3();

/** Ranged kiter: holds opts.preferredRange from the player (backs off if too
 *  close, closes if too far) and calls opts.onFire(enemy, targetPos) every
 *  opts.fireInterval seconds while roughly in range. The fire cadence is a
 *  light telegraph too — pair onFire with a muzzle flash/windup. */
export function rangedKite(enemy, targetPos, dt, opts = {}) {
  const ai = brainState(enemy);
  const preferredRange = opts.preferredRange ?? 9;
  const deadzone = opts.deadzone ?? 1.5;
  const speed = opts.speed ?? 4.5;
  _to.subVectors(enemy.position, targetPos);
  _to.y = 0;
  const dist = _to.length() || 1e-4;
  _to.multiplyScalar(1 / dist);
  if (dist < preferredRange - deadzone) {
    enemy.position.addScaledVector(_to, speed * dt); // back away
  } else if (dist > preferredRange + deadzone) {
    enemy.position.addScaledVector(_to, -speed * dt); // close in
  }
  if (opts.face) {
    _step.subVectors(targetPos, enemy.position);
    faceDir(enemy, _step);
  }
  ai.fireT = (ai.fireT ?? 0) + dt;
  const inRange = Math.abs(dist - preferredRange) <= (opts.fireBand ?? 4);
  if (inRange && ai.fireT >= (opts.fireInterval ?? 1.6)) {
    ai.fireT = 0;
    opts.onFire?.(enemy, targetPos);
  }
}

/** Pick a ready-made per-frame behavior by kind. Returns a function
 *  (enemy, targetPos, dt, opts) you can store and call each tick — lets a wave
 *  spawner stamp out mixed enemy types from a string. */
export function makeEnemyBrain(kind = 'chaser') {
  switch (kind) {
    case 'patrol':
      return (e, _t, dt, o) => patrolWaypoints(e, dt, o);
    case 'orbiter':
      return (e, t, dt, o) => strafeOrbit(e, t, dt, o);
    case 'charger':
      return (e, t, dt, o) => chargeAndRetreat(e, t, dt, o);
    case 'ranged':
      return (e, t, dt, o) => rangedKite(e, t, dt, o);
    default:
      return (e, t, dt, o) => chasePlayer(e, t, dt, o);
  }
}

// --- internals ---------------------------------------------------------------

function brainState(enemy) {
  if (!enemy.userData) enemy.userData = {};
  if (!enemy.userData.ai) enemy.userData.ai = {};
  return enemy.userData.ai;
}

function setPhase(enemy, ai, phase) {
  ai.phase = phase;
  ai.t = 0;
}

function faceDir(enemy, dir) {
  if (dir.lengthSq() < 1e-6) return;
  enemy.rotation.y = Math.atan2(dir.x, dir.z);
}

function advanceWaypoint(ai, count, opts) {
  if (opts.pingpong) {
    if (ai.wp + ai.wpDir >= count || ai.wp + ai.wpDir < 0) ai.wpDir *= -1;
    ai.wp += ai.wpDir;
  } else if (opts.loop === false) {
    ai.wp = Math.min(ai.wp + 1, count - 1);
  } else {
    ai.wp = (ai.wp + 1) % count;
  }
}

function applyTelegraph(enemy, ai, scale, colorHex) {
  enemy.scale.setScalar(scale);
  const mat = enemy.material;
  if (mat?.emissive) {
    if (ai._origEmissive === undefined) ai._origEmissive = mat.emissive.getHex();
    mat.emissive.setHex(colorHex);
  }
}

function restoreTelegraph(enemy, ai) {
  enemy.scale.setScalar(1);
  const mat = enemy.material;
  if (mat?.emissive && ai._origEmissive !== undefined) {
    mat.emissive.setHex(ai._origEmissive);
    ai._origEmissive = undefined;
  }
}

// Usage:
//   import { makeEnemyBrain, chargeAndRetreat } from './enemy-ai.jsx';
//   const brain = makeEnemyBrain(enemy.userData.kind); // 'charger' | 'ranged' | ...
//   function updateEnemy(enemy, dt) {
//     brain(enemy, player.position, dt, {
//       speed: 5, face: true, telegraphSec: 0.8,
//       onFire: (e, tgt) => spawnProjectile(e.position, tgt),
//     });
//   }
//   // Surface AI phase for playtests so escalation/telegraphs are verifiable:
//   window.__game.debug.snapshot = () => ({
//     enemyPhase: enemy.userData.ai?.phase,          // 'windup' | 'dash' | ...
//     enemyWaypoint: enemy.userData.ai?.wp,
//   });
