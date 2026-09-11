/**
 * verify_artifact's result cache must key on the whole project, not the entry.
 *
 * Run 550cef11: the agent edited src/main.js, re-ran verify_artifact, and got the
 * pre-edit verdict back in 0 ms because index.html had not changed. It concluded
 * the verifier "can't trace ES module imports" and shipped dead stub modules wired
 * straight into the page to satisfy a check that had already stopped firing.
 */
import { describe, expect, it, vi } from 'vitest';
import { makeVerifyArtifactTool } from './done.js';
import type { TextEditorFsCallbacks } from './text-editor.js';

const ENTRY =
  '<!doctype html><html lang="en"><head><title>t</title></head><body><main><canvas id="game"></canvas></main>' +
  '<script type="module" src="src/main.js"></script></body></html>';

function makeFs(files: Map<string, string>): TextEditorFsCallbacks {
  return {
    view(path) {
      const c = files.get(path);
      return c === undefined ? null : { content: c, numLines: c.split('\n').length };
    },
    create(path, content) {
      files.set(path, content);
      return { path };
    },
    strReplace() {
      throw new Error('not used');
    },
    insert() {
      throw new Error('not used');
    },
    listDir() {
      return [...files.keys()].sort();
    },
  };
}

describe('verify_artifact cache', () => {
  it('re-verifies when a sibling module changes even though index.html did not', async () => {
    const files = new Map([
      ['index.html', ENTRY],
      ['src/main.js', 'throw new Error("BUG");'],
    ]);
    const runtimeVerify = vi.fn(async () =>
      (files.get('src/main.js') ?? '').includes('BUG')
        ? [{ message: 'Uncaught Error: BUG', source: 'console.error' }]
        : [],
    );
    const tool = makeVerifyArtifactTool(makeFs(files), runtimeVerify, undefined, 'game');

    const first = await tool.execute('1', {});
    expect(first.details.status).toBe('has_errors');

    files.set('src/main.js', 'requestAnimationFrame(() => {});');
    const second = await tool.execute('2', {});
    expect(runtimeVerify).toHaveBeenCalledTimes(2);
    expect(second.details.errors.some((e) => e.message.includes('BUG'))).toBe(false);
  });

  it('still serves a cache hit when nothing in the project changed', async () => {
    const files = new Map([
      ['index.html', ENTRY],
      ['src/main.js', 'requestAnimationFrame(() => {});'],
    ]);
    const runtimeVerify = vi.fn(async () => []);
    const tool = makeVerifyArtifactTool(makeFs(files), runtimeVerify, undefined, 'game');

    await tool.execute('1', {});
    await tool.execute('2', {});
    expect(runtimeVerify).toHaveBeenCalledTimes(1);
  });

  it('re-verifies when a file is added or removed', async () => {
    const files = new Map([
      ['index.html', ENTRY],
      ['src/main.js', 'requestAnimationFrame(() => {});'],
      ['src/unused.js', 'export const x = 1;'],
    ]);
    const tool = makeVerifyArtifactTool(makeFs(files), undefined, undefined, 'game');

    const first = await tool.execute('1', {});
    expect(first.details.errors.some((e) => e.source === 'multifile.orphan_module')).toBe(true);

    files.delete('src/unused.js');
    const second = await tool.execute('2', {});
    expect(second.details.errors.some((e) => e.source === 'multifile.orphan_module')).toBe(false);
  });
});
