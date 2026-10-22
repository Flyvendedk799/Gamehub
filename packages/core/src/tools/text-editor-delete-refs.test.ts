/**
 * `delete` must not remove a module the game still loads. A live Gemini run deleted all eight
 * src/ modules in a row (entry, engine, player, enemies, ...), leaving index.html pointing at
 * files that no longer existed — the earlier behaviour only warned AFTER the files were gone.
 */
import { describe, expect, it } from 'vitest';
import { type TextEditorFsCallbacks, makeTextEditorTool } from './text-editor.js';
import { filesReferencing } from './unresolved-imports.js';

function makeFs(initial: Record<string, string>): TextEditorFsCallbacks & {
  files: Map<string, string>;
} {
  const files = new Map(Object.entries(initial));
  return {
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
    delete: (path) => files.delete(path),
  };
}

describe('delete refuses modules that are still loaded', () => {
  it('refuses a module another file imports, and deletes nothing', async () => {
    const fs = makeFs({
      'src/main.js': "import { e } from './enemies.js';\nrun(e);",
      'src/enemies.js': 'export const e = 1;',
    });
    const tool = makeTextEditorTool(fs);
    await expect(tool.execute('1', { command: 'delete', path: 'src/enemies.js' })).rejects.toThrow(
      /still loaded by src\/main\.js/,
    );
    expect(fs.files.has('src/enemies.js')).toBe(true);
  });

  it('refuses the entry module that index.html <script>-loads', async () => {
    const fs = makeFs({
      'index.html': '<script type="module" src="src/main.js"></script>',
      'src/main.js': 'run();',
    });
    const tool = makeTextEditorTool(fs);
    await expect(tool.execute('1', { command: 'delete', path: 'src/main.js' })).rejects.toThrow(
      /still loaded by index\.html/,
    );
    expect(fs.files.has('src/main.js')).toBe(true);
  });

  it('allows deleting once nothing loads the module any more', async () => {
    const fs = makeFs({
      'src/main.js': "import { e } from './enemies.js';\nrun(e);",
      'src/enemies.js': 'export const e = 1;',
    });
    const tool = makeTextEditorTool(fs);
    await tool.execute('1', { command: 'create', path: 'src/main.js', file_text: 'run();' });
    await tool.execute('2', { command: 'delete', path: 'src/enemies.js' });
    expect(fs.files.has('src/enemies.js')).toBe(false);
  });
});

describe('filesReferencing', () => {
  it('resolves relative imports, root-relative and html-relative references', () => {
    const files = [
      { path: 'src/engine/core.js', content: "import { x } from '../theme.js';" },
      { path: 'index.html', content: '<script type="module" src="src/main.js"></script>' },
      { path: 'src/main.js', content: "import('./fx.js'); // import './ghost.js'" },
      { path: 'src/theme.js', content: 'export const x = 1;' },
      { path: 'src/fx.js', content: '' },
      { path: 'src/ghost.js', content: '' },
    ];
    expect(filesReferencing(files, 'src/theme.js')).toEqual(['src/engine/core.js']);
    expect(filesReferencing(files, 'src/main.js')).toEqual(['index.html']);
    expect(filesReferencing(files, 'src/fx.js')).toEqual(['src/main.js']);
    // a mention only inside a comment is not a reference
    expect(filesReferencing(files, 'src/ghost.js')).toEqual([]);
  });
});
