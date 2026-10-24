import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function setup() {
  const input = Object.assign(new EventEmitter(), { addPointer: vi.fn() });
  const events = new EventEmitter();
  const graphic = {
    clear() {
      return this;
    },
    lineStyle() {
      return this;
    },
    strokeCircle() {
      return this;
    },
    fillStyle() {
      return this;
    },
    fillCircle() {
      return this;
    },
    setDepth() {
      return this;
    },
    setAlpha() {
      return this;
    },
    setScrollFactor() {
      return this;
    },
    setVisible() {
      return this;
    },
    setOrigin() {
      return this;
    },
    destroy: vi.fn(),
  };
  const window = new EventTarget();
  const document = Object.assign(new EventTarget(), { hidden: false });
  const source = readFileSync(new URL('./phaser/mobile-controls.js', import.meta.url), 'utf8');
  const { createMobileControls } = runInNewContext(
    `${source.replaceAll('export ', '')}\n({createMobileControls})`,
    {
      window,
      document,
      navigator: { maxTouchPoints: 2 },
    },
  ) as {
    createMobileControls: (
      scene: unknown,
      config: unknown,
    ) => {
      input: { axis: { x: number; y: number }; buttons: Record<string, boolean> };
      setVisible: (v: boolean) => void;
      destroy: () => void;
    };
  };
  const controls = createMobileControls(
    {
      input,
      events,
      cameras: { main: { height: 600 } },
      add: {
        graphics: () => graphic,
        text: () => graphic,
      },
    },
    {
      hideOnDesktop: false,
      stickX: 70,
      stickY: 500,
      buttons: [{ name: 'place', x: 700, y: 500, radius: 30 }],
    },
  );
  return { controls, input, events, graphic, window, document };
}

describe('Phaser touch controls', () => {
  it('releases an action when its finger ends outside the button', () => {
    const h = setup();
    h.input.emit('pointerdown', { id: 1, x: 700, y: 500 });
    expect(h.controls.input.buttons['place']).toBe(true);
    h.input.emit('pointerupoutside', { id: 1, x: 900, y: 200 });
    expect(h.controls.input.buttons['place']).toBe(false);
  });

  it('keeps simultaneous inputs independent and acts on initial joystick touch', () => {
    const h = setup();
    h.input.emit('pointerdown', { id: 1, x: 95, y: 500 });
    h.input.emit('pointerdown', { id: 2, x: 700, y: 500 });
    h.input.emit('pointerdown', { id: 3, x: 700, y: 500 });
    expect(h.controls.input.axis.x).toBeCloseTo(0.5);
    h.input.emit('pointerup', { id: 2, x: 0, y: 0 });
    expect(h.controls.input.buttons['place']).toBe(true);
    h.input.emit('pointerup', { id: 1 });
    expect(h.controls.input.axis.x).toBe(0);
    expect(h.controls.input.buttons['place']).toBe(true);
  });

  it('disables hidden controls, re-enables them, and clears held input on focus loss', () => {
    const h = setup();
    h.controls.setVisible(false);
    h.input.emit('pointerdown', { id: 1, x: 700, y: 500 });
    expect(h.controls.input.buttons['place']).toBe(false);
    h.controls.setVisible(true);
    h.input.emit('pointerdown', { id: 1, x: 700, y: 500 });
    expect(h.controls.input.buttons['place']).toBe(true);
    h.window.dispatchEvent(new Event('blur'));
    expect(h.controls.input.buttons['place']).toBe(false);
  });

  it('scene shutdown removes listeners so restarting cannot duplicate input handlers', () => {
    const h = setup();
    h.input.emit('pointerdown', { id: 1, x: 700, y: 500 });
    h.events.emit('shutdown');
    const destroyed = h.graphic.destroy.mock.calls.length;
    h.controls.destroy();
    expect(h.graphic.destroy.mock.calls.length).toBe(destroyed);
    expect(h.input.eventNames()).toEqual([]);
    expect(h.controls.input.buttons['place']).toBe(false);
  });
});
