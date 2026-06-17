// when_to_use: Three.js full-screen color flash / vignette for big moments —
// red when the PLAYER takes damage, white on a heavy hit-confirm, gold on a
// power-up, fade-to-black on death. Three has no post-FX flash by default, so
// the simplest robust approach is a fixed DOM overlay div over the canvas
// whose opacity is tweened — zero shaders, works regardless of renderer
// setup. Use BRIEFLY and rarely; a 150ms red wash on player-hit sells the
// damage, a flash every frame is unplayable.

/** Create a flash overlay sitting above the canvas. `mount` is the element
 *  the renderer's canvas lives in (its parent must be position:relative or
 *  the body). Returns `flash(event|{color,ms,max})` and `fade(ms,onDone)`. */
export function makeScreenFlash(mount = document.body) {
  const el = document.createElement('div');
  el.style.cssText =
    'position:fixed;inset:0;pointer-events:none;opacity:0;z-index:9999;' +
    'transition:opacity 60ms linear;background:#fff;';
  mount.appendChild(el);

  const PRESETS = {
    damage: { color: 'rgba(255,40,40,0.55)', ms: 180, max: 0.55 },
    hitConfirm: { color: 'rgba(255,255,255,0.5)', ms: 80, max: 0.5 },
    powerup: { color: 'rgba(255,220,80,0.5)', ms: 250, max: 0.5 },
    heal: { color: 'rgba(80,255,120,0.45)', ms: 260, max: 0.45 },
  };

  let timer = 0;

  return {
    /** One-shot flash: ramp opacity up then ease back to 0. */
    flash(event = 'hitConfirm', override = {}) {
      const p = PRESETS[event] ?? PRESETS.hitConfirm;
      el.style.background = override.color ?? p.color;
      el.style.transition = 'opacity 40ms linear';
      el.style.opacity = String(override.max ?? p.max);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        el.style.transition = `opacity ${override.ms ?? p.ms}ms ease-out`;
        el.style.opacity = '0';
      }, 30);
    },
    /** Fade to opaque black (death / scene exit). Calls onDone after. */
    fade(ms = 600, onDone) {
      el.style.background = '#000';
      el.style.transition = `opacity ${ms}ms ease-in`;
      el.style.opacity = '1';
      if (onDone) window.setTimeout(onDone, ms);
    },
    dispose() {
      el.remove();
    },
  };
}

// Usage:
//   const fx = makeScreenFlash();
//   function onPlayerHurt() { fx.flash('damage'); }
//   function onLandHit()    { fx.flash('hitConfirm'); }
//   function onPlayerDeath(){ fx.fade(700, () => restartGame()); }
