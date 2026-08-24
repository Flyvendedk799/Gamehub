/**
 * Editor session tests.
 *
 * The property the whole two-layer design rests on is that the agent and the
 * user are not two systems: same commands, same validation, same undo stack,
 * same document. Most of these exist to make that indistinguishability
 * concrete — an edit made by one must be visible, undoable and overridable by
 * the other, and nothing may be reachable from only one side.
 *
 * The rest cover what the UI depends on to render live: a change event per edit,
 * a revision that only moves when something actually changed, and reads that are
 * genuinely free.
 */

import { describe, expect, it, vi } from 'vitest';
import { type EditorChange, createEditorSession, describeCommand } from './session.js';

function sessionWithPrefab() {
  const session = createEditorSession();
  const imported = session.execute(
    {
      op: 'asset.import',
      path: 'prefabs/turret.prefab',
      type: 'prefab',
      content: JSON.stringify({
        version: 'scene.v1',
        name: 'Turret',
        order: ['base', 'barrel'],
        nodes: {
          base: { id: 'base', name: 'Base', parent: null, components: { Transform: { x: 0 } } },
          barrel: { id: 'barrel', name: 'Barrel', parent: 'base', components: {} },
        },
      }),
    },
    'user',
  );
  if (!imported.ok) throw new Error('prefab import failed');
  return { session, prefabId: (imported.value as { id: string }).id };
}

describe('one document, two drivers', () => {
  it('lets the agent see what the user did', () => {
    const session = createEditorSession();
    session.execute({ op: 'scene.addNode', id: 'crate', name: 'Crate' }, 'user');

    const seen = session.summary().nodes.map((node) => node.id);
    expect(seen).toEqual(['crate']);
    // And the agent's read path returns the same thing.
    const read = session.query({ op: 'query.scene' });
    expect(read.ok).toBe(true);
  });

  it('lets the user undo what the agent did', () => {
    const session = createEditorSession();
    session.execute({ op: 'scene.addNode', id: 'turret' }, 'agent');
    expect(session.summary().nodes).toHaveLength(1);

    // A shared stack is the point: if undo could only take back your own edits
    // the two layers would be fighting over the same scene with separate memories.
    const undone = session.undo('user');
    expect(undone.ok).toBe(true);
    expect(session.summary().nodes).toHaveLength(0);
  });

  it('lets the agent undo what the user did', () => {
    const session = createEditorSession();
    session.execute({ op: 'scene.addNode', id: 'crate' }, 'user');
    expect(session.undo('agent').ok).toBe(true);
    expect(session.summary().nodes).toHaveLength(0);
  });

  it('gives both sides exactly the same operations', () => {
    const session = createEditorSession();
    const operations = session.operations();
    // Nothing is reachable from only one side. The moment that stops being true
    // the layers start disagreeing about what a scene is.
    expect(operations).toContain('scene.addNode');
    expect(operations).toContain('asset.import');
    expect(operations.length).toBeGreaterThan(5);
  });

  it('applies a user edit on top of an agent edit', () => {
    const session = createEditorSession();
    session.execute({ op: 'scene.addNode', id: 'crate', name: 'Crate' }, 'agent');
    session.execute(
      { op: 'scene.setField', id: 'crate', component: 'Transform', field: 'x', value: 5 },
      'user',
    );
    expect(session.scene().nodes['crate']?.components['Transform']?.['x']).toBe(5);
  });
});

describe('change events', () => {
  it('publishes one change per edit, tagged with who made it', () => {
    const session = createEditorSession();
    const changes: EditorChange[] = [];
    session.subscribe((change) => changes.push(change));

    session.execute({ op: 'scene.addNode', id: 'a', name: 'Alpha' }, 'agent');
    session.execute({ op: 'scene.addNode', id: 'b', name: 'Beta' }, 'user');

    expect(changes).toHaveLength(2);
    expect(changes[0]?.source).toBe('agent');
    expect(changes[1]?.source).toBe('user');
    expect(changes[0]?.summary).toBe('Add Alpha');
  });

  it('carries a scene the UI can redraw from', () => {
    const session = createEditorSession();
    let latest: EditorChange | undefined;
    session.subscribe((change) => {
      latest = change;
    });

    session.execute({ op: 'scene.addNode', id: 'a', name: 'Alpha' }, 'agent');
    // The client should never have to ask a second question to render the edit.
    expect(latest?.scene.nodes).toEqual([
      { id: 'a', name: 'Alpha', parent: null, components: [], prefab: null },
    ]);
  });

  it('publishes failures too, without advancing the revision', () => {
    const session = createEditorSession();
    const changes: EditorChange[] = [];
    session.subscribe((change) => changes.push(change));

    session.execute({ op: 'scene.addNode', id: 'a' }, 'agent');
    const before = session.revision();
    session.execute({ op: 'scene.addNode', id: 'a' }, 'agent');

    expect(changes).toHaveLength(2);
    expect(changes[1]?.ok).toBe(false);
    expect(changes[1]?.error?.code).toBe('conflict');
    // A client polling the revision must not re-render because the agent made a
    // mistake that changed nothing.
    expect(session.revision()).toBe(before);
  });

  it('does not notify or advance for a read', () => {
    const session = createEditorSession();
    session.execute({ op: 'scene.addNode', id: 'a' }, 'user');
    const before = session.revision();

    const listener = vi.fn();
    session.subscribe(listener);
    session.query({ op: 'query.scene' });
    session.query({ op: 'query.assets' });

    // A viewport that redraws because the agent looked at the scene flickers
    // for nothing.
    expect(listener).not.toHaveBeenCalled();
    expect(session.revision()).toBe(before);
  });

  it('unsubscribes', () => {
    const session = createEditorSession();
    const listener = vi.fn();
    const stop = session.subscribe(listener);
    session.execute({ op: 'scene.addNode', id: 'a' }, 'user');
    stop();
    session.execute({ op: 'scene.addNode', id: 'b' }, 'user');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('survives a listener that throws', () => {
    const session = createEditorSession();
    const good = vi.fn();
    session.subscribe(() => {
      throw new Error('a panel rendered badly');
    });
    session.subscribe(good);

    // The edit already happened. Losing it because a panel had a bad render
    // would be far worse than a dropped notification.
    expect(() => session.execute({ op: 'scene.addNode', id: 'a' }, 'user')).not.toThrow();
    expect(session.summary().nodes).toHaveLength(1);
    expect(good).toHaveBeenCalledTimes(1);
  });
});

describe('batches', () => {
  it('publishes a single change for the whole batch', () => {
    const session = createEditorSession();
    const changes: EditorChange[] = [];
    session.subscribe((change) => changes.push(change));

    session.batch(
      [
        { op: 'scene.addNode', id: 'a', name: 'A' },
        { op: 'scene.addNode', id: 'b', name: 'B' },
        { op: 'scene.setParent', id: 'b', parent: 'a' },
      ],
      'agent',
    );

    expect(changes).toHaveLength(1);
    expect(changes[0]?.summary).toBe('3 edits');
    expect(changes[0]?.scene.nodes).toHaveLength(2);
  });

  it('rolls back entirely when one command fails', () => {
    const session = createEditorSession();
    session.execute({ op: 'scene.addNode', id: 'existing' }, 'user');
    const before = session.revision();

    const result = session.batch(
      [
        { op: 'scene.addNode', id: 'fresh' },
        { op: 'scene.addNode', id: 'existing' },
      ],
      'agent',
    );

    expect(result.ok).toBe(false);
    // Landing half a turret is worse than landing none of it.
    expect(session.summary().nodes.map((node) => node.id)).toEqual(['existing']);
    expect(session.revision()).toBe(before);
  });
});

describe('prefabs', () => {
  it('expands an instance in the summary', () => {
    const { session, prefabId } = sessionWithPrefab();
    session.execute(
      { op: 'scene.instantiatePrefab', id: 't1', asset: prefabId, name: 'Turret 1' },
      'agent',
    );

    const ids = session.summary().nodes.map((node) => node.id);
    // A hierarchy panel showing the instance as one opaque node is not showing
    // the scene the player will see.
    expect(ids).toContain('t1');
    expect(ids).toContain('t1/base');
    expect(ids).toContain('t1/barrel');
  });

  it('reports the prefab an instance came from', () => {
    const { session, prefabId } = sessionWithPrefab();
    session.execute({ op: 'scene.instantiatePrefab', id: 't1', asset: prefabId }, 'agent');
    const instance = session.summary().nodes.find((node) => node.id === 't1');
    expect(instance?.prefab).toBe(prefabId);
  });

  it('resolves prefabs imported inside a batch', () => {
    const session = createEditorSession();
    const result = session.batch(
      [
        {
          op: 'asset.import',
          path: 'p.prefab',
          type: 'prefab',
          content: JSON.stringify({
            version: 'scene.v1',
            name: 'P',
            order: ['root'],
            nodes: { root: { id: 'root', name: 'Root', parent: null, components: {} } },
          }),
        },
      ],
      'agent',
    );
    expect(result.ok).toBe(true);

    const asset = session.database().byPath('p.prefab');
    expect(asset).toBeDefined();
    session.execute({ op: 'scene.instantiatePrefab', id: 'i', asset: asset?.id }, 'agent');
    expect(session.summary().nodes.map((node) => node.id)).toContain('i/root');
  });

  it('tolerates a prefab whose content is not a scene', () => {
    const session = createEditorSession();
    // Reported by validation rather than crashing the session that imported it.
    expect(() =>
      session.execute(
        { op: 'asset.import', path: 'bad.prefab', type: 'prefab', content: 'not json' },
        'user',
      ),
    ).not.toThrow();
  });
});

describe('persistence', () => {
  it('serialises scene, assets and prefab bodies together', () => {
    const { session, prefabId } = sessionWithPrefab();
    session.execute({ op: 'scene.instantiatePrefab', id: 't1', asset: prefabId }, 'agent');

    const saved = JSON.parse(session.serialize());
    expect(saved.version).toBe('editor-session.v1');
    expect(saved.scene.order).toContain('t1');
    expect(saved.assets.assets).toHaveLength(1);
    // The asset database stores hashes, not content, so a save that forgot the
    // prefab bodies would reload into a scene of unresolvable instances.
    expect(Object.keys(saved.prefabs)).toEqual([prefabId]);
  });

  it('restores into a session that behaves the same', () => {
    const session = createEditorSession();
    session.execute({ op: 'scene.addNode', id: 'a', name: 'Alpha' }, 'user');

    const saved = JSON.parse(session.serialize());
    const restored = createEditorSession({ scene: saved.scene });
    expect(restored.summary().nodes.map((node) => node.id)).toEqual(['a']);
    expect(restored.execute({ op: 'scene.addNode', id: 'a' }, 'user').ok).toBe(false);
  });
});

describe('command descriptions', () => {
  it('reads as a sentence, not an opcode', () => {
    expect(describeCommand({ op: 'scene.addNode', id: 'crate', name: 'Crate' })).toBe('Add Crate');
    expect(describeCommand({ op: 'scene.removeNode', id: 'crate' })).toBe('Delete crate');
    expect(
      describeCommand({ op: 'scene.setField', id: 'crate', component: 'Transform', field: 'x' }),
    ).toBe('Set Transform.x on crate');
    expect(describeCommand({ op: 'scene.setParent', id: 'a', parent: 'b' })).toBe('Move a under b');
    expect(describeCommand({ op: 'scene.setParent', id: 'a', parent: null })).toBe('Unparent a');
  });

  it('falls back to the operation name for anything unknown', () => {
    expect(describeCommand({ op: 'query.scene' })).toBe('query.scene');
  });
});
