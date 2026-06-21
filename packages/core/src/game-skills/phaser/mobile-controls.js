// when_to_use: On-screen touch controls for mobile/tablet — reach for this
// when the game should be playable without a keyboard. Renders a virtual
// joystick (draggable thumb in a fixed base ring) and up to 4 named action
// buttons directly on the Phaser canvas using Graphics + pointer events.
// Emits a normalized input vector {x,y} and a buttons map {jump,fire,…} that
// game logic reads the same way it reads keyboard state. Also detects
// touch-vs-desktop so you can hide the overlay on non-touch devices.

import * as Phaser from 'phaser';

/** True when the runtime environment has a touch screen. */
export function isTouchDevice() {
  return (
    typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0)
  );
}

/**
 * Create on-screen mobile controls.
 *
 * config:
 *   buttons       array of {name, label, x, y, radius} — action buttons
 *   stickX/stickY position of the joystick base centre (default bottom-left)
 *   stickRadius   outer ring radius (default 50)
 *   thumbRadius   movable thumb radius (default 20)
 *   depth         render depth (default 200)
 *   alpha         overall opacity (default 0.55)
 *   hideOnDesktop auto-hide when no touch screen detected (default true)
 *
 * Returns { input, destroy, setVisible }.
 *   input.axis  -> { x, y }  normalized [-1..1] joystick direction
 *   input.buttons -> { [name]: boolean }
 */
export function createMobileControls(scene, config = {}) {
  const depth = config.depth ?? 200;
  const alpha = config.alpha ?? 0.55;
  const hideOnDesktop = config.hideOnDesktop !== false;

  // Visibility: hide on desktop unless forced.
  const shouldShow = !hideOnDesktop || isTouchDevice();

  const cam = scene.cameras.main;
  const stickX = config.stickX ?? 70;
  const stickY = config.stickY ?? cam.height - 80;
  const stickRadius = config.stickRadius ?? 50;
  const thumbRadius = config.thumbRadius ?? 20;

  const buttonDefs = config.buttons ?? [];

  // Mutable input state — game reads this every frame.
  const input = {
    axis: { x: 0, y: 0 },
    buttons: Object.fromEntries(buttonDefs.map((b) => [b.name, false])),
  };

  // --- Graphics layer (drawn in screen/fixed coords) ---
  const gfx = scene.add
    .graphics()
    .setDepth(depth)
    .setAlpha(alpha)
    .setScrollFactor(0)
    .setVisible(shouldShow);

  // Thumb position tracker.
  let thumbX = stickX;
  let thumbY = stickY;
  let stickPointerId = -1;

  function _redraw() {
    gfx.clear();

    // Joystick base ring.
    gfx.lineStyle(2, 0xffffff, 0.5);
    gfx.strokeCircle(stickX, stickY, stickRadius);

    // Thumb.
    gfx.fillStyle(0xffffff, 0.8);
    gfx.fillCircle(thumbX, thumbY, thumbRadius);

    // Action buttons.
    for (const btn of buttonDefs) {
      const pressed = input.buttons[btn.name];
      gfx.fillStyle(pressed ? 0xffd700 : 0xffffff, pressed ? 0.9 : 0.5);
      gfx.fillCircle(btn.x, btn.y, btn.radius ?? 28);
      gfx.lineStyle(2, 0xffffff, 0.7);
      gfx.strokeCircle(btn.x, btn.y, btn.radius ?? 28);
    }
  }

  // Button labels as Text objects (Graphics can't draw text).
  const labelObjs = buttonDefs.map((btn) =>
    scene.add
      .text(btn.x, btn.y, btn.label ?? btn.name.charAt(0).toUpperCase(), {
        fontSize: '14px',
        fontFamily: 'monospace',
        color: '#ffffff',
      })
      .setOrigin(0.5)
      .setDepth(depth + 1)
      .setScrollFactor(0)
      .setAlpha(0.9)
      .setVisible(shouldShow),
  );

  function _distFromStick(px, py) {
    return Math.hypot(px - stickX, py - stickY);
  }

  // Pointer events — handle multiple pointers for stick + buttons simultaneously.
  scene.input.on('pointerdown', (ptr) => {
    if (!shouldShow) return;
    const px = ptr.x;
    const py = ptr.y;

    // Check joystick hit.
    if (_distFromStick(px, py) <= stickRadius + thumbRadius && stickPointerId === -1) {
      stickPointerId = ptr.id;
      return;
    }
    // Check action buttons.
    for (const btn of buttonDefs) {
      const r = btn.radius ?? 28;
      if (Math.hypot(px - btn.x, py - btn.y) <= r) {
        input.buttons[btn.name] = true;
        _redraw();
      }
    }
  });

  scene.input.on('pointermove', (ptr) => {
    if (ptr.id !== stickPointerId) return;
    const dx = ptr.x - stickX;
    const dy = ptr.y - stickY;
    const dist = Math.hypot(dx, dy);
    const clamped = Math.min(dist, stickRadius);
    const angle = Math.atan2(dy, dx);
    thumbX = stickX + Math.cos(angle) * clamped;
    thumbY = stickY + Math.sin(angle) * clamped;
    input.axis.x = (thumbX - stickX) / stickRadius;
    input.axis.y = (thumbY - stickY) / stickRadius;
    _redraw();
  });

  scene.input.on('pointerup', (ptr) => {
    if (ptr.id === stickPointerId) {
      stickPointerId = -1;
      thumbX = stickX;
      thumbY = stickY;
      input.axis.x = 0;
      input.axis.y = 0;
      _redraw();
      return;
    }
    const px = ptr.x;
    const py = ptr.y;
    for (const btn of buttonDefs) {
      const r = btn.radius ?? 28;
      if (Math.hypot(px - btn.x, py - btn.y) <= r) {
        input.buttons[btn.name] = false;
        _redraw();
      }
    }
  });

  _redraw();

  return {
    input,
    setVisible(v) {
      gfx.setVisible(v);
      for (const l of labelObjs) l.setVisible(v);
    },
    destroy() {
      gfx.destroy();
      for (const l of labelObjs) l.destroy();
    },
  };
}

// Usage:
//   import { createMobileControls, isTouchDevice } from './engine/mobile-controls.js';
//   // create():
//   const cam = this.cameras.main;
//   this.mobileCtrl = createMobileControls(this, {
//     stickX: 80, stickY: cam.height - 90,
//     buttons: [
//       { name: 'jump', label: 'A', x: cam.width - 90, y: cam.height - 90, radius: 30 },
//       { name: 'fire', label: 'B', x: cam.width - 40, y: cam.height - 140, radius: 26 },
//     ],
//   });
//   // update(time, delta):
//   const { axis, buttons } = this.mobileCtrl.input;
//   this.player.body.setVelocityX(axis.x * 200);
//   if (buttons.jump && this.player.body.blocked.down) this.player.body.setVelocityY(-400);
//   if (buttons.fire) this.shoot();
//
//   //   window.__game.debug.snapshot = () => ({
//   //     axis: this.mobileCtrl.input.axis,
//   //     buttons: this.mobileCtrl.input.buttons,
//   //     touch: isTouchDevice(),
//   //   });
