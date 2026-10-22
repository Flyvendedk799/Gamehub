import { describe, expect, it } from 'vitest';
import { CAMERAS_3D, LAYOUTS_2D, PALETTES, describeVariation, pickVariation } from './variation';

/** A tiny deterministic generator so the rolls are reproducible. */
function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

describe('pickVariation', () => {
  it('is deterministic for a given rng and covers every dimension', () => {
    const a = pickVariation('three', seeded(7));
    const b = pickVariation('three', seeded(7));
    expect(a).toEqual(b);
    expect(a.camera.how.length).toBeGreaterThan(20);
    expect(a.palette.colors).toHaveLength(3);
  });

  it('gives different games different looks - the same prompt does not mean the same game', () => {
    const looks = new Set(
      Array.from({ length: 40 }, (_, i) => {
        const v = pickVariation('three', seeded(i + 1));
        return `${v.camera.id}|${v.style.id}|${v.setting.id}|${v.lighting.id}|${v.palette.id}`;
      }),
    );
    expect(looks.size).toBeGreaterThan(30);
  });

  it('uses 3D cameras for three and 2D layouts for the 2D engines', () => {
    for (let i = 1; i < 30; i++) {
      expect(CAMERAS_3D.some((c) => c.id === pickVariation('three', seeded(i)).camera.id)).toBe(
        true,
      );
      expect(LAYOUTS_2D.some((c) => c.id === pickVariation('phaser', seeded(i)).camera.id)).toBe(
        true,
      );
    }
  });

  it('every palette is three real hex colours', () => {
    for (const p of PALETTES) for (const c of p.colors) expect(c).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

describe('describeVariation', () => {
  it("states every choice as a binding instruction and protects the user's decisions", () => {
    const v = pickVariation('three', seeded(3));
    const text = describeVariation(v, 'three');
    expect(text).toContain('DESIGN DIRECTION (mandatory');
    expect(text).toContain(v.camera.label);
    expect(text).toContain(v.style.label);
    expect(text).toContain(v.palette.colors[1] ?? 'x');
    expect(text).toContain('the brief wins');
    expect(text).toContain('CAMERA -');
    expect(describeVariation(pickVariation('phaser', seeded(3)), 'phaser')).toContain(
      'VIEW / LAYOUT -',
    );
  });
});
