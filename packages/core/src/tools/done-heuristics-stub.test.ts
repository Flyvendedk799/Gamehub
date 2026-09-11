/**
 * Empty stub modules are dead weight shipped to the player, never a fix.
 *
 * Run 550cef11 shipped src/{enemies,fx,hud,player,theme,waves}.js as
 * `// unused stub\nexport {};`, each imported from main.js AND loaded by its own
 * <script> tag, purely to silence the orphan-module check.
 */
import { describe, expect, it } from 'vitest';
import { runHeuristics, scanStubModules } from './done-heuristics.js';

const STUB = '// unused stub — ping pong game uses src/main.js only\nexport {};\n';

describe('scanStubModules', () => {
  it('flags a module that is only comments and `export {}`', () => {
    const contents = new Map([
      ['src/main.js', "import './enemies.js';\nrequestAnimationFrame(loop);"],
      ['src/enemies.js', STUB],
    ]);
    const r = scanStubModules(contents);
    expect(r).toHaveLength(1);
    expect(r[0]?.source).toBe('multifile.stub_module');
    expect(r[0]?.message).toMatch(/src\/enemies\.js/);
    expect(r[0]?.message).toMatch(/delete/);
  });

  it('flags an empty file and a block-comment-only file', () => {
    const contents = new Map([
      ['src/a.js', ''],
      ['src/b.js', '/* TODO\n later */\n\n'],
    ]);
    expect(scanStubModules(contents).map((e) => e.message)).toHaveLength(2);
  });

  it('leaves real modules alone, however small', () => {
    const contents = new Map([
      ['src/theme.js', "export const PAL = { bg: '#000' };"],
      ['src/side-effect.js', 'window.__game.ready = true;'],
      ['src/reexport.js', "export { PAL } from './theme.js';"],
    ]);
    expect(scanStubModules(contents)).toEqual([]);
  });

  it('ignores non-JS files and assets', () => {
    const contents = new Map([
      ['index.html', ''],
      ['assets/data/empty.js', ''],
    ]);
    expect(scanStubModules(contents)).toEqual([]);
  });

  it('runs as part of runHeuristics for a multi-file game', () => {
    const html = '<script type="module" src="src/main.js"></script>';
    const contents = new Map([
      ['src/main.js', "import './enemies.js';"],
      ['src/enemies.js', STUB],
    ]);
    const errors = runHeuristics(html, new Set(contents.keys()), {
      artifactType: 'game',
      fileContents: contents,
    });
    expect(errors.some((e) => e.source === 'multifile.stub_module')).toBe(true);
  });
});
