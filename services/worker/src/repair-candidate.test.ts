import { buildRepairVerdict } from '@playforge/agent-core';
import { describe, expect, it } from 'vitest';
import { compareRepairVerdicts } from './repair-candidate';
import { WorkingTree } from './working-tree';

const predicates = [
  { field: 'connections', op: 'increased' as const },
  { field: 'energy', op: 'decreased' as const },
];
const verdict = (connections: number, energy: number, fatalErrors: string[] = []) =>
  buildRepairVerdict(
    {
      trace: {
        baseline: { connections: 0, energy: 10 },
        frames: [{ stepIndex: 0, snapshot: { connections, energy } }],
      },
      fatalErrors,
    },
    predicates,
  );

describe('repair candidate selection', () => {
  it('prefers observed working rules, then partial improvements, over a crashing repair', () => {
    expect(compareRepairVerdicts(verdict(1, 9), verdict(1, 10))).toBeGreaterThan(0);
    expect(compareRepairVerdicts(verdict(1, 10), verdict(0, 10))).toBeGreaterThan(0);
    expect(compareRepairVerdicts(verdict(0, 10), verdict(1, 9, ['crash']))).toBeGreaterThan(0);
    expect(compareRepairVerdicts(verdict(1, 9), null)).toBeGreaterThan(0);
    expect(compareRepairVerdicts(verdict(1, 9), verdict(1, 9))).toBe(0);
  });

  it('does not mistake evidence-free pass for verified behavior', () => {
    const unknown = buildRepairVerdict({ trace: null, fatalErrors: [] }, []);
    expect(unknown.pass).toBe(true);
    expect(compareRepairVerdicts(unknown, verdict(1, 10))).toBeLessThan(0);
  });

  it('restores the complete bundle, including overwritten and deleted binary assets', () => {
    const tree = new WorkingTree(
      [['src/main.js', 'before']],
      [['assets/sprite.png', new Uint8Array([1, 2, 3])]],
    );
    const before = tree.checkpoint();
    tree.create('src/main.js', 'broken');
    tree.create('assets/sprite.png', 'replacement');
    tree.create('src/broken.js', 'new');
    tree.restore(before);
    expect(tree.view('src/main.js')?.content).toBe('before');
    expect(tree.view('src/broken.js')).toBeNull();
    const restored = tree.checkpoint();
    expect(restored.binary.get('assets/sprite.png')).toEqual(new Uint8Array([1, 2, 3]));
    restored.binary.get('assets/sprite.png')?.fill(0);
    expect(tree.checkpoint().binary.get('assets/sprite.png')).toEqual(new Uint8Array([1, 2, 3]));
  });
});
