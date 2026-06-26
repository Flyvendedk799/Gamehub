import { describe, expect, it } from 'vitest';
import {
  GAMEPAD_BINDINGS_MARKER,
  GAMEPAD_BRIDGE_MARKER,
  type GamepadMappableAction,
  autoMapGamepad,
  bakeGamepadIntoHtml,
  buildBakedGamepadBindings,
  hasGamepadBindings,
  isPadCode,
  mergeGamepadBindings,
  padLabel,
} from './controls-gamepad';
import { injectControlsRuntime } from './controls-runtime';

// A realistic top-down shooter / tower-defense control set.
const ACTIONS: GamepadMappableAction[] = [
  { id: 'left', label: 'Move left', keys: ['KeyA', 'ArrowLeft'] },
  { id: 'right', label: 'Move right', keys: ['KeyD', 'ArrowRight'] },
  { id: 'up', label: 'Move up', keys: ['KeyW', 'ArrowUp'] },
  { id: 'down', label: 'Move down', keys: ['KeyS', 'ArrowDown'] },
  { id: 'attack', label: 'Attack', keys: ['KeyJ', 'Mouse0'] },
  { id: 'build', label: 'Build turret', keys: ['KeyB'] },
  { id: 'shop', label: 'Open shop', keys: ['Tab', 'KeyE'] },
  { id: 'start', label: 'Start', keys: ['Space'] },
  { id: 'look', label: 'Aim', keys: [], pointer: 'look' },
];

describe('autoMapGamepad', () => {
  const map = autoMapGamepad(ACTIONS);

  it('maps the four movement directions to dpad + left stick', () => {
    expect(map['left']).toEqual(['Pad14', 'PadLLeft']);
    expect(map['right']).toEqual(['Pad15', 'PadLRight']);
    expect(map['up']).toEqual(['Pad12', 'PadLUp']);
    expect(map['down']).toEqual(['Pad13', 'PadLDown']);
  });

  it('gives the primary action (attack) the A button', () => {
    expect(map['attack']).toEqual(['Pad0']);
  });

  it('assigns the remaining face/shoulder buttons without collisions', () => {
    const faceCodes = [map['attack'], map['build'], map['shop']].flatMap((c) => c ?? []);
    expect(new Set(faceCodes).size).toBe(faceCodes.length); // all distinct
    expect(map['build']).toBeDefined();
    expect(map['shop']).toBeDefined();
  });

  it('puts a Start-like action on the Start button (Pad9)', () => {
    expect(map['start']).toEqual(['Pad9']);
  });

  it('skips pointer-only actions', () => {
    expect(map['look']).toBeUndefined();
  });

  it('classifies directions from arrow keys even when the id is opaque', () => {
    const m = autoMapGamepad([{ id: 'thrust', keys: ['ArrowUp'] }]);
    expect(m['thrust']).toEqual(['Pad12', 'PadLUp']);
  });
});

describe('pad code helpers', () => {
  it('isPadCode recognizes buttons and stick directions, not keys', () => {
    expect(isPadCode('Pad0')).toBe(true);
    expect(isPadCode('PadLLeft')).toBe(true);
    expect(isPadCode('KeyA')).toBe(false);
    expect(isPadCode('Mouse0')).toBe(false);
  });

  it('padLabel gives friendly names', () => {
    expect(padLabel('Pad0')).toBe('A');
    expect(padLabel('Pad9')).toBe('Start');
    expect(padLabel('Pad14')).toBe('D-Pad ←');
    expect(padLabel('PadLRight')).toBe('L-Stick →');
    expect(padLabel('KeyA')).toBeNull();
  });
});

describe('mergeGamepadBindings / hasGamepadBindings', () => {
  it('appends pad codes to existing key binds and dedupes', () => {
    const bindings = { attack: ['KeyJ', 'Mouse0'], left: ['KeyA'] };
    const merged = mergeGamepadBindings(bindings, {
      attack: ['Pad0'],
      left: ['Pad14', 'PadLLeft'],
    });
    expect(merged['attack']).toEqual(['KeyJ', 'Mouse0', 'Pad0']);
    expect(merged['left']).toEqual(['KeyA', 'Pad14', 'PadLLeft']);
    // re-merging the same pads is a no-op (no duplicates)
    const again = mergeGamepadBindings(merged, { attack: ['Pad0'] });
    expect(again['attack']).toEqual(['KeyJ', 'Mouse0', 'Pad0']);
  });

  it('hasGamepadBindings detects controller codes', () => {
    expect(hasGamepadBindings({ a: ['KeyA'] })).toBe(false);
    expect(hasGamepadBindings({ a: ['KeyA', 'Pad0'] })).toBe(true);
  });
});

describe('baking into published games', () => {
  it('buildBakedGamepadBindings keeps keys AND appends pad codes', () => {
    const baked = buildBakedGamepadBindings(ACTIONS);
    expect(baked['attack']).toEqual(['KeyJ', 'Mouse0', 'Pad0']);
    expect(baked['left']).toEqual(['KeyA', 'ArrowLeft', 'Pad14', 'PadLLeft']);
    expect(baked['look']).toBeUndefined(); // pointer-only skipped
  });

  it('bakeGamepadIntoHtml writes the bindings global + bridge before </body>, idempotently', () => {
    const html = '<!doctype html><html><head></head><body><canvas></canvas></body></html>';
    const baked = buildBakedGamepadBindings(ACTIONS);
    const out = bakeGamepadIntoHtml(html, baked);
    expect(out).toContain(GAMEPAD_BINDINGS_MARKER);
    expect(out).toContain(GAMEPAD_BRIDGE_MARKER);
    expect(out).toContain('__pfGamepadBindings');
    expect(out.indexOf(GAMEPAD_BINDINGS_MARKER)).toBeLessThan(out.indexOf('</body>'));

    // Re-baking replaces the global (not a second copy) and doesn't duplicate the bridge.
    const again = bakeGamepadIntoHtml(out, { jump: ['Space', 'Pad0'] });
    expect(again.split(GAMEPAD_BINDINGS_MARKER).length - 1).toBe(1);
    expect(again.split(GAMEPAD_BRIDGE_MARKER).length - 1).toBe(1);
    expect(again).toContain('"jump"');
    expect(again).not.toContain('"attack"');
  });
});

describe('gamepad bridge injection', () => {
  it('injectControlsRuntime adds the gamepad bridge before </body>', () => {
    const out = injectControlsRuntime(
      '<!doctype html><html><head></head><body><script type="module" src="src/main.js"></script></body></html>',
    );
    expect(out).toContain(GAMEPAD_BRIDGE_MARKER);
    expect(out.indexOf(GAMEPAD_BRIDGE_MARKER)).toBeLessThan(out.indexOf('</body>'));
    // idempotent
    const twice = injectControlsRuntime(out);
    expect(twice.split(GAMEPAD_BRIDGE_MARKER).length - 1).toBe(1);
  });
});
