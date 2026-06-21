import { describe, expect, it } from 'vitest';
import { makeImportSkillTool } from './import-skill.js';

function mockFs(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed));
  const fs = {
    view: (path: string) => {
      const content = files.get(path);
      return content === undefined ? null : { content, numLines: content.split('\n').length };
    },
    create: (path: string, content: string) => {
      files.set(path, content);
      return { path };
    },
    insert: (path: string, _line: number, text: string) => {
      files.set(path, text + (files.get(path) ?? ''));
      return { path, ok: true as const };
    },
  };
  return { fs, files };
}

describe('makeImportSkillTool', () => {
  it('writes a phaser skill to src/engine/<base>.js and returns the import line + exports', async () => {
    const { fs, files } = mockFs();
    const tool = makeImportSkillTool(fs);
    const res = await tool.execute('c', { name: 'phaser/wave-spawner.js' });
    expect(res.details.path).toBe('src/engine/wave-spawner.js');
    expect(files.has('src/engine/wave-spawner.js')).toBe(true);
    expect(res.details.exports).toContain('createWaveSystem');
    expect(res.details.alreadyPresent).toBe(false);
    const text = res.content?.[0]?.type === 'text' ? res.content[0].text : '';
    expect(text).toContain("from './engine/wave-spawner.js'");
    expect(text).toContain('createWaveSystem');
    // It must NOT dump the full module source (the whole point — no retype-tokens).
    expect(text).not.toContain('export function createWaveSystem');
  });

  it('normalises a three .jsx skill to a .js import path', async () => {
    const { fs } = mockFs();
    const tool = makeImportSkillTool(fs);
    const res = await tool.execute('c', { name: 'three/enemy-ai.jsx' });
    expect(res.details.path).toBe('src/engine/enemy-ai.js');
    expect(res.details.exports.length).toBeGreaterThan(0);
  });

  it('is idempotent — a second import does not overwrite + reports alreadyPresent', async () => {
    const { fs } = mockFs();
    const tool = makeImportSkillTool(fs);
    await tool.execute('c', { name: 'phaser/save-state.js' });
    const res2 = await tool.execute('c', { name: 'phaser/save-state.js' });
    expect(res2.details.alreadyPresent).toBe(true);
  });

  it('throws with the valid list for an unknown skill', async () => {
    const { fs } = mockFs();
    const tool = makeImportSkillTool(fs);
    await expect(tool.execute('c', { name: 'phaser/nope.js' })).rejects.toThrow(/Unknown skill/);
  });

  it('P3: auto-wires a COMMENTED import stub into src/main.js when it exists', async () => {
    const { fs, files } = mockFs({ 'src/main.js': 'const x = 1;\n' });
    const tool = makeImportSkillTool(fs);
    const res = await tool.execute('c', { name: 'phaser/wave-spawner.js' });
    const main = files.get('src/main.js') ?? '';
    // The stub is COMMENTED (boot-safe) and references the canonical .js path.
    expect(main).toContain('// import { createWaveSystem');
    expect(main).toContain("from './engine/wave-spawner.js'");
    expect(main.startsWith('//')).toBe(true); // prepended at the top
    // The active code below the stub is untouched.
    expect(main).toContain('const x = 1;');
    const text = res.content?.[0]?.type === 'text' ? res.content[0].text : '';
    expect(text).toContain('src/main.js');
  });

  it('P3: no entry file → falls back to text guidance, no throw', async () => {
    const { fs } = mockFs(); // no src/main.js
    const tool = makeImportSkillTool(fs);
    const res = await tool.execute('c', { name: 'phaser/wave-spawner.js' });
    const text = res.content?.[0]?.type === 'text' ? res.content[0].text : '';
    expect(text).toContain('Add this import to your entry file');
  });
});
