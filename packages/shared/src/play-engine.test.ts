import { describe, expect, it } from 'vitest';
import { resolvePlayEngine, isEngineMismatch } from './play-engine.js';

describe('resolvePlayEngine (S0 ship honesty)', () => {
  it('prefers the project engine chosen by choose_engine', () => {
    expect(resolvePlayEngine('three', 'phaser')).toBe('three');
    expect(resolvePlayEngine('canvas2d', null)).toBe('canvas2d');
  });

  it('falls back to snapshot engine when project engine is unset', () => {
    expect(resolvePlayEngine(null, 'three')).toBe('three');
  });

  it('defaults to phaser only for legacy rows with no engine anywhere', () => {
    expect(resolvePlayEngine(null, null)).toBe('phaser');
  });

  it('detects Phaser bootstrap vs Three declaration mismatch', () => {
    expect(isEngineMismatch('three', 'phaser')).toBe(true);
    expect(isEngineMismatch('three', 'three')).toBe(false);
    expect(isEngineMismatch(null, 'phaser')).toBe(false);
  });
});
