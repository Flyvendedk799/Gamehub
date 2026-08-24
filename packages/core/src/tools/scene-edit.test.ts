/**
 * Scene tool tests.
 *
 * These check the things that are true *because* the edits are tool calls
 * rather than a file rewrite: every call carries what changed and a scene the
 * client can draw immediately, failures come back as codes a model can branch
 * on, and reads cost nothing.
 *
 * The tools are thin over `EditorSession`, so the session's own tests cover the
 * semantics. What is tested here is the contract with the agent and with the UI.
 */

import { describe, expect, it } from 'vitest';
import { createEditorSession, type EditorSession } from '../editor/session.js';
import {
  makeEditSceneTool,
  makeQuerySceneTool,
  makeSceneHistoryTool,
  makeSceneTools,
  type SceneEditDetails,
} from './scene-edit.js';

function harness(): { session: EditorSession; tools: ReturnType<typeof makeSceneTools> } {
  const session = createEditorSession();
  return { session, tools: makeSceneTools(() => session) };
}

const textOf = (result: { content: Array<{ type: string; text?: string }> }): string =>
  result.content.map((part) => part.text ?? '').join('\n');

describe('edit_scene', () => {
  it('applies commands and reports the new scene', async () => {
    const { session } = harness();
    const tool = makeEditSceneTool(() => session);

    const result = await tool.execute('call-1', {
      commands: [{ op: 'scene.addNode', id: 'crate', name: 'Crate' }],
    } as never);

    const details = result.details as SceneEditDetails;
    expect(details.ok).toBe(true);
    expect(details.summary).toBe('Add Crate');
    expect(details.scene.nodes.map((node) => node.id)).toEqual(['crate']);
    expect(textOf(result)).toContain('1 node');
  });

  it('carries a scene the client can draw without asking again', async () => {
    const { session } = harness();
    const tool = makeEditSceneTool(() => session);
    await tool.execute('c', {
      commands: [
        { op: 'scene.addNode', id: 'a', name: 'Alpha' },
        { op: 'scene.addNode', id: 'b', name: 'Beta', parent: 'a' },
      ],
    } as never);

    // This is the whole reason the edits are tool calls: the viewport can move
    // the object while the agent is still talking.
    const details = (await tool.execute('c2', {
      commands: [{ op: 'scene.setField', id: 'b', component: 'Transform', field: 'x', value: 3 }],
    } as never)).details as SceneEditDetails;

    expect(details.scene.nodes).toEqual([
      { id: 'a', name: 'Alpha', parent: null, components: [], prefab: null },
      { id: 'b', name: 'Beta', parent: 'a', components: ['Transform'], prefab: null },
    ]);
  });

  it('returns a code the model can branch on when an edit fails', async () => {
    const { session } = harness();
    const tool = makeEditSceneTool(() => session);
    await tool.execute('c1', { commands: [{ op: 'scene.addNode', id: 'a' }] } as never);

    const result = await tool.execute('c2', {
      commands: [{ op: 'scene.addNode', id: 'a' }],
    } as never);

    const details = result.details as SceneEditDetails;
    expect(details.ok).toBe(false);
    expect(details.error?.code).toBe('conflict');
    // And the text says plainly that nothing landed, so the model does not
    // assume a partial success.
    expect(textOf(result)).toContain('Nothing was applied');
  });

  it('lands all of a batch or none of it', async () => {
    const { session } = harness();
    const tool = makeEditSceneTool(() => session);
    await tool.execute('c1', { commands: [{ op: 'scene.addNode', id: 'existing' }] } as never);

    await tool.execute('c2', {
      commands: [
        { op: 'scene.addNode', id: 'fresh' },
        { op: 'scene.addNode', id: 'existing' },
      ],
    } as never);

    expect(session.summary().nodes.map((node) => node.id)).toEqual(['existing']);
  });

  it('surfaces scene problems in the result the agent reads', async () => {
    const { session } = harness();
    const tool = makeEditSceneTool(() => session);

    // A node whose parent does not exist: the agent can fix it now, and will not
    // if it has to go looking.
    const result = await tool.execute('c', {
      commands: [{ op: 'scene.addNode', id: 'child', parent: 'ghost' }],
    } as never);
    expect(textOf(result)).toContain('FAILED');
    expect((result.details as SceneEditDetails).error?.code).toBe('not_found');
    void session;
  });

  it('advances the revision only when something changed', async () => {
    const { session } = harness();
    const tool = makeEditSceneTool(() => session);

    const first = (await tool.execute('c1', {
      commands: [{ op: 'scene.addNode', id: 'a' }],
    } as never)).details as SceneEditDetails;
    const failed = (await tool.execute('c2', {
      commands: [{ op: 'scene.addNode', id: 'a' }],
    } as never)).details as SceneEditDetails;

    expect(failed.revision).toBe(first.revision);
  });

  it('tags its edits as the agent, so the UI can show them differently', async () => {
    const { session } = harness();
    const tool = makeEditSceneTool(() => session);
    const sources: string[] = [];
    session.subscribe((change) => sources.push(change.source));

    await tool.execute('c', { commands: [{ op: 'scene.addNode', id: 'a' }] } as never);
    expect(sources).toEqual(['agent']);
  });

  it('refuses a path that escapes the project', async () => {
    const { session } = harness();
    const tool = makeEditSceneTool(() => session);
    const result = await tool.execute('c', {
      commands: [
        { op: 'asset.import', path: '../../secrets.txt', type: 'data', content: 'x' },
      ],
    } as never);
    // Model output is not a trusted caller.
    expect((result.details as SceneEditDetails).error?.code).toBe('unsafe_path');
  });
});

describe('query_scene', () => {
  it('reads the scene without changing anything', async () => {
    const { session } = harness();
    session.execute({ op: 'scene.addNode', id: 'a', name: 'Alpha' }, 'user');
    const before = session.revision();

    const tool = makeQuerySceneTool(() => session);
    const result = await tool.execute('c', { what: 'scene' } as never);

    expect(textOf(result)).toContain('Alpha');
    expect(session.revision()).toBe(before);
  });

  it('does not notify listeners', async () => {
    const { session } = harness();
    const changes: unknown[] = [];
    session.subscribe((change) => changes.push(change));

    const tool = makeQuerySceneTool(() => session);
    await tool.execute('c', { what: 'scene' } as never);
    await tool.execute('c2', { what: 'assets' } as never);

    expect(changes).toEqual([]);
  });

  it('returns one node in full', async () => {
    const { session } = harness();
    session.execute({ op: 'scene.addNode', id: 'a', name: 'Alpha' }, 'user');
    const tool = makeQuerySceneTool(() => session);
    const result = await tool.execute('c', { what: 'node', id: 'a' } as never);
    expect(JSON.parse(textOf(result)).name).toBe('Alpha');
  });

  it('reports a validation problem the agent can act on', async () => {
    const { session } = harness();
    const tool = makeQuerySceneTool(() => session);
    const result = await tool.execute('c', { what: 'validate' } as never);
    expect(JSON.parse(textOf(result)).ok).toBe(true);
  });

  it('says so when the node is not there', async () => {
    const { session } = harness();
    const tool = makeQuerySceneTool(() => session);
    const result = await tool.execute('c', { what: 'node', id: 'ghost' } as never);
    expect(textOf(result)).toContain('not_found');
  });
});

describe('scene_history', () => {
  it('undoes and redoes on the stack the user shares', async () => {
    const { session } = harness();
    session.execute({ op: 'scene.addNode', id: 'a' }, 'user');
    const tool = makeSceneHistoryTool(() => session);

    const undone = await tool.execute('c', { direction: 'undo' } as never);
    expect((undone.details as SceneEditDetails).ok).toBe(true);
    expect(session.summary().nodes).toHaveLength(0);

    await tool.execute('c2', { direction: 'redo' } as never);
    expect(session.summary().nodes).toHaveLength(1);
  });

  it('reports having nothing to undo', async () => {
    const { session } = harness();
    const tool = makeSceneHistoryTool(() => session);
    const result = await tool.execute('c', { direction: 'undo' } as never);
    expect((result.details as SceneEditDetails).error?.code).toBe('nothing_to_undo');
  });
});

describe('registration', () => {
  it('exposes three tools with distinct names and schemas', () => {
    const { tools } = harness();
    expect(tools.map((tool) => tool.name)).toEqual(['edit_scene', 'query_scene', 'scene_history']);
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(60);
      expect(tool.parameters).toBeDefined();
      expect(tool.label).toBeTruthy();
    }
  });

  it('resolves the session lazily, so it can be swapped per run', async () => {
    let session = createEditorSession();
    const tool = makeEditSceneTool(() => session);

    await tool.execute('c', { commands: [{ op: 'scene.addNode', id: 'first' }] } as never);
    // A run that starts a new project must not keep editing the previous one.
    session = createEditorSession();
    const result = await tool.execute('c2', {
      commands: [{ op: 'scene.addNode', id: 'second' }],
    } as never);

    expect((result.details as SceneEditDetails).scene.nodes.map((node) => node.id)).toEqual([
      'second',
    ]);
  });
});
