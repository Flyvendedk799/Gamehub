import { describe, expect, it } from 'vitest';
import { isRepairablePath, parseFileBlocks, repairUnresolvedImports } from './import-repair';

const BROKEN = [
  {
    path: 'src/main.js',
    content: "import { buildCraft } from './player.js';\nbuildCraft();\n// placeholder wiring",
  },
  {
    path: 'src/player.js',
    content: 'export class Player { constructor() { this.hp = 100; this.stance = "mid"; } }',
  },
];

function harness(replies: string[]) {
  const tree = new Map(BROKEN.map((f) => [f.path, f.content]));
  const writes: string[] = [];
  let calls = 0;
  return {
    tree,
    writes,
    calls: () => calls,
    options: {
      brief: 'a sword fighting game',
      listFiles: () => [...tree].map(([path, content]) => ({ path, content })),
      write: (path: string, content: string) => {
        writes.push(path);
        tree.set(path, content);
      },
      generate: async () => replies[Math.min(calls++, replies.length - 1)] ?? '',
    },
  };
}

const FIX = `=== FILE: src/main.js ===
import { Player } from './player.js';
const player = new Player();
window.__game.debug.track({ score: () => 0, playerPos: () => ({ x: 0 }) });
console.log(player.hp);
=== END FILE ===`;

describe('parseFileBlocks / isRepairablePath', () => {
  it('parses blocks, strips a stray markdown fence, and only allows src js paths', () => {
    const blocks = parseFileBlocks(
      '=== FILE: src/a.js ===\n```js\nexport const a = 1;\n```\n=== END FILE ===\n=== FILE: index.html ===\n<x>\n=== END FILE ===',
    );
    expect(blocks.map((b) => b.path)).toEqual(['src/a.js', 'index.html']);
    expect(blocks[0]?.content).toBe('export const a = 1;');
    expect(isRepairablePath('src/a.js')).toBe(true);
    expect(isRepairablePath('index.html')).toBe(false);
    expect(isRepairablePath('src/../x.js')).toBe(false);
  });
});

describe('repairUnresolvedImports', () => {
  it('rewrites the leftover module so every import resolves', async () => {
    const h = harness([FIX]);
    const result = await repairUnresolvedImports(h.options);
    expect(result.remaining).toEqual([]);
    expect(result.written).toEqual(['src/main.js']);
    expect(h.tree.get('src/main.js')).toContain("import { Player } from './player.js'");
    // the gameplay module the model really wrote is untouched
    expect(h.tree.get('src/player.js')).toContain('class Player');
  });

  it('does nothing (no model call) when imports already resolve', async () => {
    const h = harness([FIX]);
    h.tree.set('src/main.js', "import { Player } from './player.js';\nnew Player();");
    const result = await repairUnresolvedImports(h.options);
    expect(result.attempts).toBe(0);
    expect(h.calls()).toBe(0);
  });

  it('leaves the project untouched when the reply is unusable, and never throws', async () => {
    const h = harness(['sorry, I cannot do that']);
    const before = h.tree.get('src/main.js');
    const result = await repairUnresolvedImports(h.options);
    expect(h.writes).toEqual([]);
    expect(h.tree.get('src/main.js')).toBe(before);
    expect(result.remaining.length).toBeGreaterThan(0);
  });

  it('refuses a reply that does not reduce the number of unresolved imports', async () => {
    const worse = `=== FILE: src/main.js ===\nimport { nope, alsoNope } from './player.js';\nnope();\nalsoNope(); // still broken wiring here\n=== END FILE ===`;
    const h = harness([worse, worse]);
    const result = await repairUnresolvedImports(h.options);
    expect(h.writes).toEqual([]);
    expect(result.remaining.length).toBeGreaterThan(0);
  });

  it('survives a generate() that throws', async () => {
    const h = harness([]);
    h.options.generate = async () => {
      throw new Error('503');
    };
    const result = await repairUnresolvedImports(h.options);
    expect(h.writes).toEqual([]);
    expect(result.remaining.length).toBeGreaterThan(0);
  });
});

describe('repairUnresolvedImports also fixes calls to controls members that do not exist', () => {
  it('replaces controls.active with the real API in one call', async () => {
    const tree = new Map([
      [
        'src/main.js',
        "const dx = window.__game.controls.active('right') ? 1 : 0; // wiring for the duel loop\nexport const x = dx;",
      ],
    ]);
    const fixed = `=== FILE: src/main.js ===
const dx = window.__game.controls.isDown('right') ? 1 : 0; // wiring for the duel loop
export const x = dx;
=== END FILE ===`;
    const result = await repairUnresolvedImports({
      brief: 'a sword fighting game',
      listFiles: () => [...tree].map(([path, content]) => ({ path, content })),
      write: (path, content) => void tree.set(path, content),
      generate: async () => fixed,
    });
    expect(result.remaining).toEqual([]);
    expect(tree.get('src/main.js')).toContain("controls.isDown('right')");
  });
});
