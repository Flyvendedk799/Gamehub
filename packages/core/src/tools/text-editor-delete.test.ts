/**
 * `delete` command — the missing half of the orphan-module advice.
 *
 * Run 550cef11 was told "or delete the file" with no way to do it, so it replaced
 * six starter modules with `export {}` stubs and loaded them from index.html to
 * silence the check. The stubs shipped in the user's project.
 */
import { describe, expect, it } from 'vitest';
import { type TextEditorFsCallbacks, makeTextEditorTool } from './text-editor.js';

function makeFs(
  initial: Record<string, string>,
  opts: { withDelete?: boolean } = {},
): TextEditorFsCallbacks & { files: Map<string, string> } {
  const files = new Map(Object.entries(initial));
  const fs: TextEditorFsCallbacks & { files: Map<string, string> } = {
    files,
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
  if (opts.withDelete !== false) fs.delete = (path) => files.delete(path);
  return fs;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? '').join('');
}

describe('str_replace_based_edit_tool delete', () => {
  it('removes a file the game no longer uses', async () => {
    const fs = makeFs({ 'src/main.js': 'run();', 'src/enemies.js': 'export const e = 1;' });
    const tool = makeTextEditorTool(fs);
    const result = await tool.execute('1', { command: 'delete', path: 'src/enemies.js' });
    expect(fs.files.has('src/enemies.js')).toBe(false);
    expect(textOf(result)).toMatch(/Deleted src\/enemies\.js/);
  });

  it('warns when another file still references the deleted module', async () => {
    const fs = makeFs({
      'src/main.js': "import { e } from './enemies.js';\nrun(e);",
      'src/enemies.js': 'export const e = 1;',
    });
    const tool = makeTextEditorTool(fs);
    const result = await tool.execute('1', { command: 'delete', path: 'src/enemies.js' });
    expect(textOf(result)).toMatch(/src\/main\.js/);
    expect(textOf(result)).toMatch(/still reference/);
  });

  it('refuses to delete the page entry', async () => {
    const fs = makeFs({ 'index.html': '<canvas></canvas>' });
    const tool = makeTextEditorTool(fs);
    await expect(tool.execute('1', { command: 'delete', path: 'index.html' })).rejects.toThrow(
      /entry/,
    );
    expect(fs.files.has('index.html')).toBe(true);
  });

  it('reports a missing path instead of pretending it deleted something', async () => {
    const fs = makeFs({ 'src/main.js': 'run();' });
    const tool = makeTextEditorTool(fs);
    await expect(tool.execute('1', { command: 'delete', path: 'src/nope.js' })).rejects.toThrow(
      /not found/i,
    );
  });

  it('refuses cleanly on a host without delete support', async () => {
    const fs = makeFs({ 'src/enemies.js': 'x' }, { withDelete: false });
    const tool = makeTextEditorTool(fs);
    await expect(tool.execute('1', { command: 'delete', path: 'src/enemies.js' })).rejects.toThrow(
      /not available/,
    );
  });

  it('rejects a traversal path before touching the fs', async () => {
    const fs = makeFs({ 'src/main.js': 'run();' });
    const tool = makeTextEditorTool(fs);
    await expect(tool.execute('1', { command: 'delete', path: '../secrets.js' })).rejects.toThrow();
  });
});
