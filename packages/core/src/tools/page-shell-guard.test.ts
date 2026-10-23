/**
 * Once the host has drafted a game, the page shell is the host's.
 *
 * Run a985c47a recreated index.html, renamed the canvas to `game-canvas`, and the game died at
 * boot with "Cannot read properties of null (reading 'width')". These tests pin the two defences:
 * a from-scratch rewrite of the page is refused once armed, and a renamed canvas is put back at
 * the moment of the edit.
 */
import { describe, expect, it } from 'vitest';
import { createPageShellGuard } from './page-shell-guard.js';
import { type TextEditorFsCallbacks, makeTextEditorTool } from './text-editor.js';

const PAGE = `<!doctype html>
<html><head><title>Game</title>
<script type="importmap">{"imports":{"three":"https://cdnjs.cloudflare.com/ajax/libs/three.js/0.160.0/three.module.js"}}</script>
</head><body>
<canvas id="game"></canvas>
<script type="module" src="src/main.js"></script>
</body></html>`;

const MAIN = "import { createStage } from './engine/core.js';\nconst stage = createStage('game');";

function makeFs(initial: Record<string, string>): TextEditorFsCallbacks {
  const files = new Map(Object.entries(initial));
  return {
    view(path) {
      const c = files.get(path);
      return c === undefined ? null : { content: c, numLines: c.split('\n').length };
    },
    textFiles() {
      return [...files.entries()].map(([path, content]) => ({ path, content }));
    },
    create(path, content) {
      files.set(path, content);
      return { path };
    },
    strReplace(path, oldStr, newStr) {
      const c = files.get(path);
      if (c === undefined || !c.includes(oldStr)) throw new Error('old_str not found');
      files.set(path, c.replace(oldStr, newStr));
      return { path, startLine: 1, endLine: 1, totalLines: 1 };
    },
    insert() {
      throw new Error('not used');
    },
    listDir() {
      return [...files.keys()].sort();
    },
  };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? '').join('');
}

describe('whole-file create over index.html', () => {
  it('is allowed before the host draft has landed', async () => {
    const guard = createPageShellGuard();
    const fs = makeFs({ 'index.html': PAGE, 'src/main.js': MAIN });
    const tool = makeTextEditorTool(fs, undefined, undefined, guard);
    const result = await tool.execute('1', {
      command: 'create',
      path: 'index.html',
      file_text: PAGE.replace('<title>Game', '<title>Mine'),
    });
    expect(textOf(result)).toContain('Created index.html');
  });

  it('is refused once armed, with the reason and the alternative', async () => {
    const guard = createPageShellGuard();
    guard.arm();
    const fs = makeFs({ 'index.html': PAGE, 'src/main.js': MAIN });
    const tool = makeTextEditorTool(fs, undefined, undefined, guard);
    await expect(
      tool.execute('1', { command: 'create', path: 'index.html', file_text: '<html></html>' }),
    ).rejects.toThrow(/Refusing to recreate `index\.html`.*str_replace/s);
    // The page on disk is untouched.
    expect(fs.view('index.html')?.content).toBe(PAGE);
  });

  it('still lets a draft that never wrote a page create one', async () => {
    const guard = createPageShellGuard();
    guard.arm();
    const fs = makeFs({ 'src/main.js': MAIN });
    const tool = makeTextEditorTool(fs, undefined, undefined, guard);
    const result = await tool.execute('1', {
      command: 'create',
      path: 'index.html',
      file_text: PAGE,
    });
    expect(textOf(result)).toContain('Created index.html');
  });

  it('never blocks other files', async () => {
    const guard = createPageShellGuard();
    guard.arm();
    const fs = makeFs({ 'index.html': PAGE, 'src/main.js': MAIN });
    const tool = makeTextEditorTool(fs, undefined, undefined, guard);
    const result = await tool.execute('1', {
      command: 'create',
      path: 'src/main.js',
      file_text: `${MAIN}\nconsole.log('hi');`,
    });
    expect(textOf(result)).toContain('Created src/main.js');
  });
});

describe('renamed canvas id', () => {
  it('is restored right after a str_replace renames it, and the result says so', async () => {
    const guard = createPageShellGuard();
    const fs = makeFs({ 'index.html': PAGE, 'src/main.js': MAIN });
    const tool = makeTextEditorTool(fs, undefined, undefined, guard);
    const result = await tool.execute('1', {
      command: 'str_replace',
      path: 'index.html',
      old_str: '<canvas id="game"></canvas>',
      new_str: '<canvas id="game-canvas"></canvas>',
    });
    expect(fs.view('index.html')?.content).toContain('<canvas id="game"></canvas>');
    expect(fs.view('index.html')?.content).not.toContain('game-canvas');
    expect(textOf(result)).toMatch(/restored id="game"/);
  });

  it('is restored after a from-scratch create when not armed (non-drafted runs)', async () => {
    const guard = createPageShellGuard();
    const fs = makeFs({ 'src/main.js': MAIN });
    const tool = makeTextEditorTool(fs, undefined, undefined, guard);
    const result = await tool.execute('1', {
      command: 'create',
      path: 'index.html',
      file_text: PAGE.replace('id="game"', 'id="gameCanvas"'),
    });
    expect(fs.view('index.html')?.content).toContain('id="game"');
    expect(textOf(result)).toMatch(/restored id="game"/);
  });

  it('leaves an edit alone when the code looks up the new id', async () => {
    const guard = createPageShellGuard();
    const fs = makeFs({ 'index.html': PAGE, 'src/main.js': MAIN.replace("'game'", "'arena'") });
    const tool = makeTextEditorTool(fs, undefined, undefined, guard);
    const result = await tool.execute('1', {
      command: 'str_replace',
      path: 'index.html',
      old_str: '<canvas id="game"></canvas>',
      new_str: '<canvas id="arena"></canvas>',
    });
    expect(fs.view('index.html')?.content).toContain('id="arena"');
    expect(textOf(result)).not.toMatch(/restored id=/);
  });

  it('does nothing for edits to other files', async () => {
    const guard = createPageShellGuard();
    const fs = makeFs({ 'index.html': PAGE, 'src/main.js': MAIN });
    const tool = makeTextEditorTool(fs, undefined, undefined, guard);
    const result = await tool.execute('1', {
      command: 'str_replace',
      path: 'src/main.js',
      old_str: 'const stage',
      new_str: 'const arenaStage',
    });
    expect(textOf(result)).not.toMatch(/restored id=/);
  });
});
