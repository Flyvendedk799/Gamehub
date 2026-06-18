/**
 * Tool-layer path-traversal guard (#49) — unit coverage for assertSafeToolPath
 * and integration coverage through the text_editor + list_files tools, proving
 * the assertion fires BEFORE any fs callback runs.
 */

import { describe, expect, it, vi } from 'vitest';
import { makeListFilesTool } from './list-files.js';
import { assertSafeToolPath } from './path-safety.js';
import { type TextEditorFsCallbacks, makeTextEditorTool } from './text-editor.js';

const REJECTED: Array<[string, string]> = [
  ['POSIX-absolute', '/etc/passwd'],
  ['leading slash', '/index.html'],
  ['parent traversal', '../secret.txt'],
  ['nested parent traversal', 'a/b/../../../etc/passwd'],
  ['bare ..', '..'],
  ['trailing ..', 'foo/..'],
  ['home expansion', '~/secret'],
  ['bare ~', '~'],
  ['backslash root', '\\windows\\system32'],
  ['drive letter', 'C:\\Users\\me'],
  ['drive letter forward slash', 'C:/Users/me'],
  ['backslash traversal', '..\\..\\etc'],
  // Control chars built from escapes so no literal bytes live in source.
  ['NUL byte', `index.html${String.fromCharCode(0)}.png`],
  ['bell control char', `ab${String.fromCharCode(7)}.txt`],
  ['DEL control char', `ab${String.fromCharCode(0x7f)}.txt`],
  ['newline control char', `a${String.fromCharCode(10)}b.txt`],
  ['empty', ''],
  ['whitespace only', '   '],
  // Aligned with the storage-layer guard so the two layers accept the same set
  // (no surprise late failure at persist time).
  ['single-dot segment', 'a/./b.html'],
  ['leading dot segment', './index.html'],
  ['trailing slash (empty last segment)', 'assets/'],
  ['double slash (empty middle segment)', 'assets//hero.png'],
  // Non-NFC (decomposed) form of "é" — storage rejects non-NFC paths.
  ['non-NFC decomposed unicode', `cafe${String.fromCharCode(0x301)}.html`],
];

const ACCEPTED = ['index.html', 'src/main.ts', 'assets/sprites/hero.png', '_starters/frame.jsx'];

describe('assertSafeToolPath', () => {
  for (const [label, path] of REJECTED) {
    it(`rejects ${label}: ${JSON.stringify(path)}`, () => {
      expect(() => assertSafeToolPath(path, 'test_tool')).toThrow(/test_tool refused/);
    });
  }

  for (const path of ACCEPTED) {
    it(`accepts root-relative path ${JSON.stringify(path)}`, () => {
      expect(() => assertSafeToolPath(path, 'test_tool')).not.toThrow();
    });
  }
});

/** Tracking fs whose callbacks throw if ever invoked — proves the guard runs
 *  before any fs access. */
function trackingFs(): { fs: TextEditorFsCallbacks; touched: () => boolean } {
  let wasTouched = false;
  const boom = (name: string) => (): never => {
    wasTouched = true;
    throw new Error(`fs.${name} should not have been reached`);
  };
  return {
    touched: () => wasTouched,
    fs: {
      view: boom('view') as TextEditorFsCallbacks['view'],
      create: boom('create') as unknown as TextEditorFsCallbacks['create'],
      strReplace: boom('strReplace') as unknown as TextEditorFsCallbacks['strReplace'],
      insert: boom('insert') as unknown as TextEditorFsCallbacks['insert'],
      patch: boom('patch') as unknown as NonNullable<TextEditorFsCallbacks['patch']>,
      listDir: boom('listDir') as TextEditorFsCallbacks['listDir'],
    },
  };
}

describe('text_editor path-traversal guard (#49)', () => {
  it('rejects an absolute path before touching the fs (view)', async () => {
    const { fs, touched } = trackingFs();
    const tool = makeTextEditorTool(fs);
    await expect(
      tool.execute('id', { command: 'view', path: '/etc/passwd' }, undefined),
    ).rejects.toThrow(/str_replace_based_edit_tool refused/);
    expect(touched()).toBe(false);
  });

  it('rejects ".." traversal on create before touching the fs', async () => {
    const { fs, touched } = trackingFs();
    const tool = makeTextEditorTool(fs);
    await expect(
      tool.execute('id', { command: 'create', path: '../escape.html', file_text: 'x' }, undefined),
    ).rejects.toThrow(/parent-directory traversal/);
    expect(touched()).toBe(false);
  });

  it('rejects a NUL byte in the path on str_replace', async () => {
    const { fs } = trackingFs();
    const tool = makeTextEditorTool(fs);
    await expect(
      tool.execute(
        'id',
        {
          command: 'str_replace',
          path: `index${String.fromCharCode(0)}.html`,
          old_str: 'a',
          new_str: 'b',
        },
        undefined,
      ),
    ).rejects.toThrow(/control character/);
  });

  it('still allows a legitimate root-relative create', async () => {
    const created: string[] = [];
    const fs: TextEditorFsCallbacks = {
      view: () => null,
      create: (path) => {
        created.push(path);
        return { path };
      },
      strReplace: () => {
        throw new Error('unused');
      },
      insert: () => {
        throw new Error('unused');
      },
      listDir: () => [],
    };
    const tool = makeTextEditorTool(fs);
    await tool.execute(
      'id',
      { command: 'create', path: 'assets/level.json', file_text: '{}' },
      undefined,
    );
    expect(created).toEqual(['assets/level.json']);
  });
});

describe('list_files path-traversal guard (#49)', () => {
  it('rejects an absolute dir before touching the fs', async () => {
    const listDir = vi.fn(() => [] as string[]);
    const tool = makeListFilesTool({ listDir } as unknown as TextEditorFsCallbacks);
    await expect(tool.execute('id', { dir: '/etc' }, undefined)).rejects.toThrow(
      /list_files refused/,
    );
    expect(listDir).not.toHaveBeenCalled();
  });

  it('rejects a ".." dir before touching the fs', async () => {
    const listDir = vi.fn(() => [] as string[]);
    const tool = makeListFilesTool({ listDir } as unknown as TextEditorFsCallbacks);
    await expect(tool.execute('id', { dir: '../..' }, undefined)).rejects.toThrow(
      /parent-directory traversal/,
    );
    expect(listDir).not.toHaveBeenCalled();
  });

  it('allows the default (root) listing — empty dir is legitimate', async () => {
    const listDir = vi.fn(() => ['index.html']);
    const tool = makeListFilesTool({ listDir } as unknown as TextEditorFsCallbacks);
    const res = await tool.execute('id', {}, undefined);
    expect(listDir).toHaveBeenCalledWith('');
    expect(res.details.entries).toEqual(['index.html']);
  });

  it('allows a legitimate sub-dir listing', async () => {
    const listDir = vi.fn(() => ['hero.png']);
    const tool = makeListFilesTool({ listDir } as unknown as TextEditorFsCallbacks);
    const res = await tool.execute('id', { dir: 'assets/sprites' }, undefined);
    expect(listDir).toHaveBeenCalledWith('assets/sprites');
    expect(res.details.entries).toEqual(['hero.png']);
  });
});
