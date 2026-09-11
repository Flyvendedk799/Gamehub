/**
 * `create` over an existing module names the modules the rewrite orphaned.
 *
 * Run 550cef11 recreated the starter's src/main.js with a single import and got
 * back only "Created src/main.js"; the six modules it cut loose surfaced three
 * verifies later as orphan errors, and were papered over with stubs.
 */
import { describe, expect, it } from 'vitest';
import { type TextEditorFsCallbacks, makeTextEditorTool } from './text-editor.js';

function makeFs(initial: Record<string, string>): TextEditorFsCallbacks {
  const files = new Map(Object.entries(initial));
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

const STARTER = {
  'src/engine/core.js': 'export function runLoop() {}',
  'src/main.js':
    "import { runLoop } from './engine/core.js';\nimport { PAL } from './theme.js';\nimport { drawHud } from './hud.js';\nrunLoop();",
  'src/theme.js': 'export const PAL = {};',
  'src/hud.js': "import { PAL } from './theme.js';\nexport function drawHud() {}",
};

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? '').join('');
}

describe('create over an existing module', () => {
  it('names the modules the rewrite left unloaded', async () => {
    const tool = makeTextEditorTool(makeFs(STARTER));
    const result = await tool.execute('1', {
      command: 'create',
      path: 'src/main.js',
      file_text: "import { runLoop } from './engine/core.js';\nrunLoop(() => {});",
    });
    const text = textOf(result);
    expect(text).toMatch(/nothing loads any more/);
    expect(text).toContain('src/hud.js');
    expect(text).toContain('src/theme.js');
    expect(text).not.toContain('src/engine/core.js,');
    expect(text).toMatch(/command: "delete"/);
  });

  it('says nothing when the rewrite keeps every import', async () => {
    const tool = makeTextEditorTool(makeFs(STARTER));
    const result = await tool.execute('1', {
      command: 'create',
      path: 'src/main.js',
      file_text: `${STARTER['src/main.js']}\nconsole.log('more');`,
    });
    expect(textOf(result)).not.toMatch(/nothing loads any more/);
  });

  it('says nothing for a brand-new file', async () => {
    const tool = makeTextEditorTool(makeFs(STARTER));
    const result = await tool.execute('1', {
      command: 'create',
      path: 'src/extra.js',
      file_text: 'export const x = 1;',
    });
    expect(textOf(result)).not.toMatch(/nothing loads any more/);
  });
});
