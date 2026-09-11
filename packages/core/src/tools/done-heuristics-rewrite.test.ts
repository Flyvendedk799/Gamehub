/**
 * Which modules does a rewrite leave behind with nothing loading them?
 *
 * Run 550cef11 recreated src/main.js from scratch and silently orphaned six
 * starter modules; it only found out three verifies later, and "fixed" it with
 * stubs. The edit that orphans them should say so, while the answer is cheap.
 */
import { describe, expect, it } from 'vitest';
import {
  modulesOrphanedByRewrite,
  orphanedJsModulePaths,
  stubModulePaths,
} from './done-heuristics.js';

const OLD_MAIN = "import { a } from './a.js';\nimport './b.js';\nrun(a);";
const ENTRY = '<script type="module" src="src/main.js"></script>';

describe('modulesOrphanedByRewrite', () => {
  it('lists every module the rewrite cut loose, transitively', () => {
    const files = new Map([
      ['index.html', ENTRY],
      ['src/main.js', 'run();'],
      ['src/a.js', 'export const a = 1;'],
      ['src/b.js', "import './c.js';"],
      ['src/c.js', 'export const c = 1;'],
    ]);
    expect(modulesOrphanedByRewrite('src/main.js', OLD_MAIN, files)).toEqual([
      'src/a.js',
      'src/b.js',
      'src/c.js',
    ]);
  });

  it('works before index.html exists by rooting at the rewritten file', () => {
    const files = new Map([
      ['src/main.js', 'run();'],
      ['src/a.js', 'export const a = 1;'],
      ['src/b.js', 'export const b = 1;'],
    ]);
    expect(modulesOrphanedByRewrite('src/main.js', OLD_MAIN, files)).toEqual([
      'src/a.js',
      'src/b.js',
    ]);
  });

  it('does not list a module the new version still imports', () => {
    const files = new Map([
      ['index.html', ENTRY],
      ['src/main.js', "import './b.js';\nrun();"],
      ['src/a.js', 'export const a = 1;'],
      ['src/b.js', 'export const b = 1;'],
    ]);
    expect(modulesOrphanedByRewrite('src/main.js', OLD_MAIN, files)).toEqual(['src/a.js']);
  });

  it('is empty for a rewrite that keeps the same imports', () => {
    const files = new Map([
      ['index.html', ENTRY],
      ['src/main.js', `${OLD_MAIN}\nmore();`],
      ['src/a.js', 'export const a = 1;'],
      ['src/b.js', 'export const b = 1;'],
    ]);
    expect(modulesOrphanedByRewrite('src/main.js', OLD_MAIN, files)).toEqual([]);
  });
});

describe('path helpers behind the orphan and stub scans', () => {
  it('orphanedJsModulePaths returns paths, not messages', () => {
    const contents = new Map([['src/main.js', 'run();']]);
    expect(orphanedJsModulePaths('<p>no scripts</p>', new Set(['src/main.js']), contents)).toEqual([
      'src/main.js',
    ]);
  });

  it('stubModulePaths returns the comment-only modules', () => {
    const contents = new Map([
      ['src/main.js', 'run();'],
      ['src/hud.js', '// unused stub\nexport {};'],
    ]);
    expect(stubModulePaths(contents)).toEqual(['src/hud.js']);
  });
});
