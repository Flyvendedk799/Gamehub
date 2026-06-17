// when_to_use: Three.js hitstop / freeze-frame + slow-mo — pause or slow the
// game clock for a few frames on impact so hits land with weight. In a
// delta-time render loop you don't pause rAF; you scale `dt` to 0 (freeze)
// or a fraction (slow-mo) for a short window. This is the highest-leverage
// 3D melee/impact primitive — it makes a hit "connect" instead of clipping
// through. Drive ALL gameplay (physics, animation mixers, movement) off the
// SCALED dt this returns, not the raw frame dt.

/** Create a time controller. Each frame call `clock.scale(rawDt)` and use the
 *  returned scaled dt for all gameplay updates. Trigger `clock.freeze(ms)` or
 *  `clock.slow(factor, ms)` on impact. Real-time (wall-clock) windows, so the
 *  freeze always ends even though gameplay dt is 0. */
export function makeTimeController() {
  let frozenUntil = 0;
  let slowUntil = 0;
  let slowFactor = 1;
  const now = () => performance.now();

  return {
    /** Hard freeze for `ms` real milliseconds. */
    freeze(ms = 80) {
      frozenUntil = Math.max(frozenUntil, now() + ms);
    },
    /** Slow-mo to `factor` (0..1) for `ms` real ms. Use on big kills/parries. */
    slow(factor = 0.25, ms = 250) {
      slowFactor = factor;
      slowUntil = Math.max(slowUntil, now() + ms);
    },
    /** Convert raw frame dt → gameplay dt. Call once per frame. */
    scale(rawDt) {
      const t = now();
      if (t < frozenUntil) return 0;
      if (t < slowUntil) return rawDt * slowFactor;
      return rawDt;
    },
    get isFrozen() {
      return now() < frozenUntil;
    },
  };
}

// Usage:
//   const clock = makeTimeController();
//   function onMeleeConnect(heavy) { clock.freeze(heavy ? 120 : 70); }
//   function onBossKill()          { clock.slow(0.2, 500); }
//   function onUpdate(rawDt) {
//     const dt = clock.scale(rawDt);   // 0 during freeze
//     player.update(dt);               // gameplay reads SCALED dt
//     mixer.update(dt);                // anim mixer too — freezes the pose
//     // shaker.update(rawDt);         // juice that should keep moving uses rawDt
//   }
