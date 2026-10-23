import { describe, expect, it } from 'vitest';
import { resolveControlKey } from './control-intents';

/** The manifest the shipped duel from run a985c47a declared. */
const DUEL = {
  actions: [
    { id: 'forward', label: 'Step Forward', keys: ['KeyW', 'ArrowUp'] },
    { id: 'backward', label: 'Step Back', keys: ['KeyS', 'ArrowDown'] },
    { id: 'stepLeft', label: 'Dodge Left', keys: ['KeyA', 'ArrowLeft'] },
    { id: 'stepRight', label: 'Dodge Right', keys: ['KeyD', 'ArrowRight'] },
    { id: 'light', label: 'Light Attack', keys: ['KeyJ', 'Mouse0'] },
    { id: 'heavy', label: 'Heavy Attack', keys: ['KeyK'] },
    { id: 'block', label: 'Block', keys: ['KeyL', 'Mouse2'] },
    { id: 'parry', label: 'Parry', keys: ['Space'] },
  ],
};

describe('resolveControlKey', () => {
  it('finds the keys the game actually binds', () => {
    expect(resolveControlKey(DUEL, 'forward')).toBe('KeyW');
    expect(resolveControlKey(DUEL, 'attack')).toBe('KeyJ');
    expect(resolveControlKey(DUEL, 'heavy')).toBe('KeyK');
  });

  it('follows a rebinding instead of guessing', () => {
    const rebound = {
      actions: [
        { id: 'advance', label: 'Advance', keys: ['KeyI'] },
        { id: 'slash', label: 'Slash', keys: ['KeyU'] },
        { id: 'power', label: 'Power strike', keys: ['KeyO'] },
      ],
    };
    expect(resolveControlKey(rebound, 'forward')).toBe('KeyI');
    expect(resolveControlKey(rebound, 'attack')).toBe('KeyU');
    expect(resolveControlKey(rebound, 'heavy')).toBe('KeyO');
  });

  it('does not mistake a different action for the one asked for', () => {
    const manifest = {
      actions: [
        { id: 'back', label: 'Step back', keys: ['KeyS'] },
        { id: 'dodge', label: 'Dodge forward', keys: ['ShiftLeft'] },
        { id: 'block', label: 'Block attack', keys: ['KeyL'] },
        { id: 'heavy', label: 'Heavy attack', keys: ['KeyK'] },
      ],
    };
    expect(resolveControlKey(manifest, 'forward')).toBeNull();
    // "heavy" is not the light attack, and "Block attack" is not an attack.
    expect(resolveControlKey(manifest, 'attack')).toBeNull();
    expect(resolveControlKey(manifest, 'heavy')).toBe('KeyK');
  });

  it('skips non-keyboard bindings and takes the first real key', () => {
    const manifest = {
      actions: [{ id: 'attack', label: 'Attack', keys: ['Mouse0', 'Gamepad0', 'KeyF'] }],
    };
    expect(resolveControlKey(manifest, 'attack')).toBe('KeyF');
    expect(
      resolveControlKey(
        { actions: [{ id: 'attack', label: 'Attack', keys: ['Mouse0'] }] },
        'attack',
      ),
    ).toBeNull();
  });

  it('returns null for anything it cannot trust, so the step keeps its own key', () => {
    expect(resolveControlKey(null, 'forward')).toBeNull();
    expect(resolveControlKey(undefined, 'forward')).toBeNull();
    expect(resolveControlKey({}, 'forward')).toBeNull();
    expect(resolveControlKey({ actions: 'nope' }, 'forward')).toBeNull();
    expect(
      resolveControlKey({ actions: [null, 7, { id: 5, keys: 'KeyW' }] }, 'forward'),
    ).toBeNull();
    expect(resolveControlKey(DUEL, 'unknown-intent')).toBeNull();
  });
});
