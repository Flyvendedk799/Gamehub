import { describe, expect, it } from 'vitest';
import { makeAddControllerSupportTool } from './add-controller-support.js';
import type { TextEditorFsCallbacks } from './text-editor.js';

function fakeFs(files: Record<string, string>): TextEditorFsCallbacks {
  return {
    view: (p) =>
      files[p] !== undefined ? { content: files[p], numLines: files[p].split('\n').length } : null,
    create: (p, c) => {
      files[p] = c;
      return { path: p };
    },
    strReplace: () => ({ ok: true }) as never,
    insert: () => ({ ok: true }) as never,
    listDir: () => Object.keys(files),
  };
}

const ACTIONS = [
  { id: 'left', keys: ['KeyA', 'ArrowLeft'] },
  { id: 'right', keys: ['KeyD', 'ArrowRight'] },
  { id: 'attack', keys: ['KeyJ', 'Mouse0'] },
  { id: 'start', keys: ['Space'] },
  { id: 'look', keys: [], pointer: 'look' },
];

describe('add_controller_support tool', () => {
  it('bakes the gamepad bridge + bindings into index.html and reports the mapping', async () => {
    const files = {
      'index.html': '<!doctype html><html><head></head><body><canvas></canvas></body></html>',
    };
    const tool = makeAddControllerSupportTool(fakeFs(files));
    const res = await tool.execute('t1', { actions: ACTIONS });

    expect(files['index.html']).toContain('__pfGamepadBindings');
    expect(files['index.html']).toContain('pf-gamepad-bridge');
    // Baked bindings keep the keys and add the pad codes (movement also stick).
    expect(files['index.html']).toContain('Pad0'); // attack → A
    expect(files['index.html']).toContain('PadLLeft'); // left → stick

    const mapped = res.details.mapped;
    expect(mapped.find((m) => m.id === 'attack')?.buttons).toEqual(['A']);
    expect(mapped.find((m) => m.id === 'left')?.buttons).toEqual(['D-Pad ←', 'L-Stick ←']);
    expect(mapped.find((m) => m.id === 'start')?.buttons).toEqual(['Start']);
    // pointer-only action is skipped
    expect(mapped.find((m) => m.id === 'look')).toBeUndefined();
  });

  it('throws when there are no mappable actions', async () => {
    const tool = makeAddControllerSupportTool(fakeFs({ 'index.html': '<body></body>' }));
    await expect(
      tool.execute('t', { actions: [{ id: 'look', keys: [], pointer: 'look' }] }),
    ).rejects.toThrow(/No mappable/);
  });

  it('throws when the HTML document is missing', async () => {
    const tool = makeAddControllerSupportTool(fakeFs({}));
    await expect(tool.execute('t', { actions: [{ id: 'jump', keys: ['Space'] }] })).rejects.toThrow(
      /not found/,
    );
  });
});
