// when_to_use: On-screen touch controls for Three.js games running on mobile —
// a virtual joystick + up to 4 configurable action buttons rendered as a DOM
// overlay on top of the canvas. Reach for this when a game needs to run on
// touch devices without a physical keyboard. Uses Pointer Events (not Touch
// Events) so it works on both touch screens and mouse/stylus. Detects touch
// vs desktop automatically: the overlay is hidden on hover-capable devices
// unless forceShow is set. Exports a normalized stick vector (–1..1 on X/Z)
// and a button-state map you read each frame — same interface as keyboard input
// so game logic stays device-agnostic.

/** Create mobile controls overlay bound to `container`.
 *
 *  opts:
 *    buttons        -> [{ id, label, color? }]  — up to 4 action buttons (right side)
 *    stickSize      -> px diameter of the stick zone (default 120)
 *    buttonSize     -> px diameter of each button (default 56)
 *    forceShow      -> always show even on desktop (default false)
 *    opacity        -> overlay element opacity (default 0.75)
 *    deadzone       -> normalised deadzone radius [0..1] (default 0.12)
 *
 *  Returns { update(), getAxis(), getButtons(), isTouch(), destroy() }
 *  getAxis()    → { x: float [-1..1], y: float [-1..1] }  (x=strafe, y=forward)
 *  getButtons() → Map<id, bool>  — true while held
 */
export function createMobileControls(container, opts = {}) {
  const stickSize = opts.stickSize ?? 120;
  const btnSize = opts.buttonSize ?? 56;
  const deadzone = opts.deadzone ?? 0.12;
  const opacity = opts.opacity ?? 0.75;
  const buttonDefs = opts.buttons ?? [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' },
  ];

  // --- touch detection ---
  const hasCoarse =
    typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;
  let touchActive = hasCoarse || (opts.forceShow ?? false);

  // --- state ---
  let stickPointer = null; // { pointerId, originX, originY }
  let rawDx = 0;
  let rawDy = 0;
  const buttonState = new Map(buttonDefs.map((b) => [b.id, false]));
  const buttonPointers = new Map(); // pointerId → buttonId

  // --- root overlay ---
  const overlay = document.createElement('div');
  overlay.style.cssText = [
    'position:absolute',
    'inset:0',
    'pointer-events:none',
    `opacity:${opacity}`,
    'z-index:100',
    'touch-action:none',
    `display:${touchActive ? 'block' : 'none'}`,
  ].join(';');
  container.style.position ||= 'relative';
  container.append(overlay);

  // --- joystick ---
  const stickZone = mkEl('div', {
    position: 'absolute',
    bottom: '24px',
    left: '24px',
    width: `${stickSize}px`,
    height: `${stickSize}px`,
    borderRadius: '50%',
    background: 'rgba(255,255,255,0.15)',
    border: '2px solid rgba(255,255,255,0.35)',
    boxSizing: 'border-box',
    pointerEvents: 'auto',
    touchAction: 'none',
  });
  const thumb = mkEl('div', {
    position: 'absolute',
    width: `${stickSize * 0.38}px`,
    height: `${stickSize * 0.38}px`,
    borderRadius: '50%',
    background: 'rgba(255,255,255,0.55)',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%,-50%)',
    pointerEvents: 'none',
    transition: 'transform 0.05s',
  });
  stickZone.append(thumb);
  overlay.append(stickZone);

  // --- buttons ---
  const btnRow = mkEl('div', {
    position: 'absolute',
    bottom: '24px',
    right: '24px',
    display: 'flex',
    gap: '10px',
    alignItems: 'flex-end',
    pointerEvents: 'none',
  });
  overlay.append(btnRow);

  const buttonEls = new Map();
  for (const def of buttonDefs) {
    const color = def.color ?? '#4a90e2';
    const el = mkEl('div', {
      width: `${btnSize}px`,
      height: `${btnSize}px`,
      borderRadius: '50%',
      background: color,
      border: '2px solid rgba(255,255,255,0.4)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: '#fff',
      fontWeight: '700',
      fontSize: `${Math.round(btnSize * 0.35)}px`,
      fontFamily: 'sans-serif',
      boxSizing: 'border-box',
      pointerEvents: 'auto',
      touchAction: 'none',
      userSelect: 'none',
      transition: 'filter 0.05s',
    });
    el.textContent = def.label ?? def.id.toUpperCase();
    el.dataset.btnId = def.id;
    btnRow.append(el);
    buttonEls.set(def.id, el);
  }

  // --- stick pointer events ---
  stickZone.addEventListener('pointerdown', (e) => {
    if (stickPointer !== null) return;
    stickZone.setPointerCapture(e.pointerId);
    const r = stickZone.getBoundingClientRect();
    stickPointer = {
      pointerId: e.pointerId,
      originX: r.left + stickSize / 2,
      originY: r.top + stickSize / 2,
    };
    e.preventDefault();
  });

  stickZone.addEventListener('pointermove', (e) => {
    if (stickPointer === null || e.pointerId !== stickPointer.pointerId) return;
    const dx = e.clientX - stickPointer.originX;
    const dy = e.clientY - stickPointer.originY;
    const maxR = stickSize / 2;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const capped = dist > maxR ? maxR / dist : 1;
    rawDx = (dx * capped) / maxR;
    rawDy = (dy * capped) / maxR;
    // Move thumb visually.
    const px = dx * capped + stickSize / 2;
    const py = dy * capped + stickSize / 2;
    thumb.style.left = `${px}px`;
    thumb.style.top = `${py}px`;
  });

  function releaseStick(e) {
    if (stickPointer === null || e.pointerId !== stickPointer.pointerId) return;
    stickPointer = null;
    rawDx = 0;
    rawDy = 0;
    thumb.style.left = '50%';
    thumb.style.top = '50%';
  }
  stickZone.addEventListener('pointerup', releaseStick);
  stickZone.addEventListener('pointercancel', releaseStick);

  // --- button pointer events ---
  for (const [id, el] of buttonEls) {
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      buttonPointers.set(e.pointerId, id);
      buttonState.set(id, true);
      el.style.filter = 'brightness(1.4)';
      e.preventDefault();
    });
    el.addEventListener('pointerup', (e) => {
      const btnId = buttonPointers.get(e.pointerId);
      if (btnId) {
        buttonState.set(btnId, false);
        buttonPointers.delete(e.pointerId);
        buttonEls.get(btnId).style.filter = '';
      }
    });
    el.addEventListener('pointercancel', (e) => {
      const btnId = buttonPointers.get(e.pointerId);
      if (btnId) {
        buttonState.set(btnId, false);
        buttonPointers.delete(e.pointerId);
        buttonEls.get(btnId).style.filter = '';
      }
    });
  }

  // Show overlay when first touch is detected even on desktop.
  window.addEventListener(
    'touchstart',
    () => {
      if (!touchActive && !opts.forceShow) {
        touchActive = true;
        overlay.style.display = 'block';
      }
    },
    { once: true },
  );

  // ---------------------------------------------------------------------------
  // Public API.
  // ---------------------------------------------------------------------------

  /** Read normalised stick vector. x = strafe, y = forward (negative = up). */
  function getAxis() {
    const len = Math.sqrt(rawDx * rawDx + rawDy * rawDy);
    if (len < deadzone) return { x: 0, y: 0 };
    const scale = (len - deadzone) / (1 - deadzone) / len;
    return { x: rawDx * scale, y: rawDy * scale };
  }

  /** True while the given button id is held. */
  function isPressed(id) {
    return buttonState.get(id) ?? false;
  }

  /** Full button state snapshot. */
  function getButtons() {
    return new Map(buttonState);
  }

  /** Whether the device appears to use touch. */
  function isTouch() {
    return touchActive;
  }

  /** No-op: controls are fully event-driven. Call update(dt) from the loop for
   *  consistency with other skills (e.g. to drive axis-based camera later). */
  function update(_dt) {
    /* event-driven; reserved for future smoothing */
  }

  function destroy() {
    overlay.remove();
  }

  function getState() {
    const axis = getAxis();
    return {
      touchActive,
      axisX: axis.x,
      axisY: axis.y,
      buttons: Object.fromEntries(buttonState),
    };
  }

  return { update, getAxis, isPressed, getButtons, isTouch, destroy, getState };
}

// --- util ---
function mkEl(tag, styles) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(styles)) el.style[k] = v;
  return el;
}

// Usage:
//   import { createMobileControls } from './mobile-controls.jsx';
//
//   const controls = createMobileControls(document.getElementById('game-root'), {
//     buttons: [
//       { id: 'jump',  label: '↑', color: '#44cc77' },
//       { id: 'fire',  label: '🔥', color: '#e05c2a' },
//     ],
//     stickSize: 130,
//     deadzone: 0.15,
//   });
//
//   function onUpdate(dt) {
//     controls.update(dt);
//     const { x, y } = controls.getAxis();
//     // x = left/right strafe, y = forward/back (negative = forward for most games)
//     player.position.x += x * speed * dt;
//     player.position.z += y * speed * dt;
//     if (controls.isPressed('jump') && player.onGround) { player.vy = jumpForce; }
//     if (controls.isPressed('fire')) { shoot(); }
//   }
//   window.__game.debug.snapshot = () => controls.getState();
//   // => { touchActive: true, axisX: 0.3, axisY: -0.8, buttons: { jump: false, fire: true } }
