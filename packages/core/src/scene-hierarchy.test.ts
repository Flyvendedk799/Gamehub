import { describe, expect, it } from 'vitest';
import { buildHierarchy, reparentCommand, setFieldCommand } from './scene-hierarchy.js';

describe('S12 scene hierarchy', () => {
  it('builds a forest from flat nodes', () => {
    const model = buildHierarchy(
      [
        { id: 'root', name: 'Root', parent: null, components: ['Transform'] },
        { id: 'child', name: 'Crate', parent: 'root', components: ['Mesh'] },
      ],
      'child',
    );
    expect(model.roots).toHaveLength(1);
    expect(model.roots[0]!.children[0]!.name).toBe('Crate');
    expect(model.selectedId).toBe('child');
  });

  it('maps reparent + setField gestures to session commands', () => {
    expect(reparentCommand('child', 'root')).toMatchObject({ id: 'child', parent: 'root' });
    expect(setFieldCommand('child', 'transform.x', 3)).toMatchObject({
      id: 'child',
      field: 'transform.x',
      value: 3,
    });
  });
});
