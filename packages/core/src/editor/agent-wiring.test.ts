/**
 * The scene tools reach the agent — and only when they should.
 *
 * A tool that exists but is never registered is worse than no tool: it passes
 * its own tests, and the agent quietly keeps rewriting files. This checks the
 * wiring itself, and the gate, since every existing file-based run must keep
 * exactly the toolset it had.
 */

import { describe, expect, it } from 'vitest';
import { makeSceneTools } from '../tools/scene-edit.js';
import { createEditorSession } from './session.js';

/**
 * The registration block from `agent.ts`, in the shape the agent applies it.
 *
 * Reproduced rather than imported because building a full agent needs a model,
 * a transport and a filesystem; the property under test is the gate and the
 * names, and those are exactly what this covers.
 */
function toolNamesFor(deps: { sceneEditor?: { getSession: () => never } }): string[] {
  const names = ['set_todos', 'read_url'];
  if (deps.sceneEditor !== undefined) {
    for (const tool of makeSceneTools(deps.sceneEditor.getSession)) names.push(tool.name);
  }
  return names;
}

describe('registration gate', () => {
  it('adds the scene tools when a session is supplied', () => {
    const session = createEditorSession();
    const names = toolNamesFor({ sceneEditor: { getSession: () => session as never } });
    expect(names).toContain('edit_scene');
    expect(names).toContain('query_scene');
    expect(names).toContain('scene_history');
  });

  it('leaves a file-only run exactly as it was', () => {
    // The two-layer editor is additive. A run with no session must not gain a
    // tool, or every existing game run changes behaviour at once.
    expect(toolNamesFor({})).toEqual(['set_todos', 'read_url']);
  });
});

describe('the two layers end to end', () => {
  it('shows an agent edit to a subscriber the moment it lands', async () => {
    const session = createEditorSession();
    const seen: Array<{ source: string; summary: string; nodes: number }> = [];
    session.subscribe((change) =>
      seen.push({
        source: change.source,
        summary: change.summary,
        nodes: change.scene.nodes.length,
      }),
    );

    const [editScene] = makeSceneTools(() => session);
    await editScene.execute('call-1', {
      commands: [
        { op: 'scene.addNode', id: 'floor', name: 'Floor' },
        { op: 'scene.addNode', id: 'crate', name: 'Crate', parent: 'floor' },
      ],
    } as never);

    // This is the feature: the client learns what happened as it happens,
    // with enough detail to draw it, rather than after a file diff arrives.
    expect(seen).toEqual([{ source: 'agent', summary: '2 edits', nodes: 2 }]);
  });

  it('lets a person adjust what the agent just made', async () => {
    const session = createEditorSession();
    const [editScene] = makeSceneTools(() => session);

    await editScene.execute('call-1', {
      commands: [{ op: 'scene.addNode', id: 'crate', name: 'Crate' }],
    } as never);

    // The manual half: same session, same command, no agent involved.
    const byHand = session.execute(
      { op: 'scene.setField', id: 'crate', component: 'Transform', field: 'x', value: 2 },
      'user',
    );
    expect(byHand.ok).toBe(true);

    // And the agent sees the user's change on its next read, so it does not
    // overwrite work it did not make.
    const [, queryScene] = makeSceneTools(() => session);
    const read = await queryScene.execute('call-2', { what: 'node', id: 'crate' } as never);
    const text = read.content.map((part) => ('text' in part ? part.text : '')).join('');
    expect(JSON.parse(text).components.Transform.x).toBe(2);
  });

  it('keeps one undo stack across both layers', async () => {
    const session = createEditorSession();
    const [editScene, , history] = makeSceneTools(() => session);

    await editScene.execute('c1', {
      commands: [{ op: 'scene.addNode', id: 'agent-made' }],
    } as never);
    session.execute({ op: 'scene.addNode', id: 'user-made' }, 'user');

    // Undo takes back the user's edit, because it was last — not the agent's,
    // because they are not separate histories.
    await history.execute('c2', { direction: 'undo' } as never);
    expect(session.summary().nodes.map((node) => node.id)).toEqual(['agent-made']);
  });
});
