import { describe, expect, it } from 'vitest';
import { applyEditRequest, outlineOf, parseLocateReply } from './edit-pipeline';

const NL = String.fromCharCode(10);
const block = (path: string, body: string) =>
  [`=== FILE: ${path} ===`, body, '=== END FILE ==='].join(NL);

const FX = [
  '// effects',
  'export function spawnSlashArc(fx, pos, rotY) {',
  '  const mesh = makeArc();',
  '  mesh.rotation.z = rotY; // BUG: ignores aim',
  '  return mesh;',
  '}',
  ...Array.from({ length: 30 }, (_, i) => `// padding line number ${i} to keep the file realistic`),
].join(NL);
const MAIN = [
  "import { spawnSlashArc } from './fx.js';",
  'function attack() { spawnSlashArc(fx, player.position, player.rotation.y); }',
  ...Array.from({ length: 30 }, (_, i) => `// main padding ${i}`),
].join(NL);

function harness(replies: string[]) {
  const tree = new Map<string, string>([
    ['src/fx.js', FX],
    ['src/main.js', MAIN],
    ['index.html', '<canvas id="game"></canvas>'],
  ]);
  const writes: string[] = [];
  const prompts: string[] = [];
  return {
    tree,
    writes,
    prompts,
    options: {
      request: 'the strike effect should follow the mouse direction',
      listFiles: () => [...tree].map(([path, content]) => ({ path, content })),
      write: (path: string, content: string) => {
        writes.push(path);
        tree.set(path, content);
      },
      generate: async (_s: string, user: string) => {
        prompts.push(user);
        return replies[Math.min(prompts.length - 1, replies.length - 1)] ?? '';
      },
    },
  };
}

const LOCATE = '{"files": ["src/fx.js"], "why": "the arc is built in fx.js"}';
const GOOD_FX = FX.replace(
  'mesh.rotation.z = rotY; // BUG: ignores aim',
  'mesh.rotation.y = rotY; // follows the aim angle',
);

describe('outline / locate parsing', () => {
  it('outlines declarations with line numbers', () => {
    expect(outlineOf({ path: 'src/fx.js', content: FX })).toContain(
      'L2: export function spawnSlashArc',
    );
  });

  it('keeps only known files and caps the list', () => {
    const known = new Set(['src/a.js', 'src/b.js', 'src/c.js', 'src/d.js']);
    expect(
      parseLocateReply('{"files":["src/a.js","nope.js","src/b.js","src/c.js","src/d.js"]}', known),
    ).toEqual(['src/a.js', 'src/b.js', 'src/c.js']);
    expect(parseLocateReply('not json', known)).toEqual([]);
  });
});

describe('applyEditRequest', () => {
  it('locates the file, rewrites exactly it, and writes only what changed', async () => {
    const h = harness([LOCATE, block('src/fx.js', GOOD_FX)]);
    const result = await applyEditRequest(h.options);
    expect(result.files).toEqual(['src/fx.js']);
    expect(h.tree.get('src/fx.js')).toContain('mesh.rotation.y = rotY');
    expect(h.tree.get('src/main.js')).toBe(MAIN);
    expect(h.writes).toEqual(['src/fx.js']);
    // the edit prompt carries the FULL file and the request, and only outlines for the rest
    expect(h.prompts[1]).toContain('mesh.rotation.z = rotY; // BUG');
    expect(h.prompts[1]).toContain('the strike effect should follow the mouse direction');
  });

  it('retries once, naming the damage, when the first rewrite guts the file', async () => {
    const h = harness([LOCATE, block('src/fx.js', '// shortened'), block('src/fx.js', GOOD_FX)]);
    const result = await applyEditRequest(h.options);
    expect(result.files).toEqual(['src/fx.js']);
    expect(h.prompts[2]).toContain('much shorter than the original');
  });

  it('refuses a rewrite that breaks the project (unresolved import) and writes nothing', async () => {
    const broken = GOOD_FX.replace('export function spawnSlashArc', 'export function renamedArc');
    const h = harness([LOCATE, block('src/fx.js', broken)]);
    await expect(applyEditRequest(h.options)).rejects.toThrow(/no acceptable edit/);
    expect(h.writes).toEqual([]);
    expect(h.tree.get('src/fx.js')).toBe(FX);
    expect(h.prompts[2]).toContain('spawnSlashArc');
  });

  it('refuses a no-op rewrite', async () => {
    const h = harness([LOCATE, block('src/fx.js', FX), block('src/fx.js', FX)]);
    await expect(applyEditRequest(h.options)).rejects.toThrow(/unchanged/);
    expect(h.writes).toEqual([]);
  });

  it('throws when it cannot tell which file the request is about', async () => {
    const h = harness(['I am not sure']);
    await expect(applyEditRequest(h.options)).rejects.toThrow(/which file/);
  });
});

describe('applyEditRequest diagnostics', () => {
  it('reports why the first attempt was thrown away, for the server log', async () => {
    const h = harness([LOCATE, block('src/fx.js', '// shortened'), block('src/fx.js', GOOD_FX)]);
    const seen: string[] = [];
    await applyEditRequest({ ...h.options, debug: (m: string) => seen.push(m) });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('attempt 1 discarded');
    expect(seen[0]).toContain('much shorter than the original');
  });
});

describe('applyEditRequest with SEARCH/REPLACE hunks', () => {
  const hunkReply = (search: string, replace: string) =>
    [
      '=== SUMMARY ===',
      '- Slashes now follow where you aim.',
      '=== END SUMMARY ===',
      '=== EDIT: src/fx.js ===',
      '<<<<<<< SEARCH',
      search,
      '=======',
      replace,
      '>>>>>>> REPLACE',
      '=== END EDIT ===',
    ].join(NL);

  it('applies a hunk, leaves every other line alone, and returns the player-facing summary', async () => {
    const h = harness([
      LOCATE,
      hunkReply(
        '  mesh.rotation.z = rotY; // BUG: ignores aim',
        '  mesh.rotation.y = rotY; // follows the aim angle',
      ),
    ]);
    const result = await applyEditRequest(h.options);
    expect(result.files).toEqual(['src/fx.js']);
    expect(h.tree.get('src/fx.js')).toBe(GOOD_FX);
    expect(result.summary).toBe('- Slashes now follow where you aim.');
  });

  it('asks for hunks first, and for whole files only after a hunk fails to apply', async () => {
    const h = harness([
      LOCATE,
      hunkReply('  mesh.rotation.q = rotY; // not in the file', '  x'),
      block('src/fx.js', GOOD_FX),
    ]);
    const system: string[] = [];
    const generate = h.options.generate;
    h.options.generate = async (s: string, u: string) => {
      system.push(s);
      return generate(s, u);
    };
    const result = await applyEditRequest(h.options);
    expect(result.files).toEqual(['src/fx.js']);
    expect(system[1]).toContain('SEARCH/REPLACE');
    expect(system[2]).not.toContain('Change only what is needed, using SEARCH/REPLACE');
    expect(h.prompts[2]).toContain('not in the file');
  });
});
