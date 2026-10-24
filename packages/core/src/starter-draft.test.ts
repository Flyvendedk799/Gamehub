import { describe, expect, it } from 'vitest';
import { PREMIUM_STARTER_FILES, unmodifiedStarterEngine } from './premium-starters';
import {
  buildDraftSystemPrompt,
  buildDraftUserPrompt,
  draftGameFromStarter,
  isWritableDraftPath,
} from './starter-draft';

const NL = String.fromCharCode(10);
const starterTree = () => new Map<string, string>(Object.entries(PREMIUM_STARTER_FILES.three));

function block(path: string, body: string): string {
  return [`=== FILE: ${path} ===`, body, '=== END FILE ==='].join(NL);
}

const GOOD_MAIN =
  "import { Player } from './player.js'; // the real duel wiring, long enough to be a real module";
const GOOD_PLAYER =
  'export class Player { constructor() { this.hp = 100; this.stance = "mid"; this.stamina = 100; } }';

describe('unmodifiedStarterEngine', () => {
  it('names the engine while the tree is the pristine seed, null after any src change', () => {
    const tree = starterTree();
    const read = (p: string) => tree.get(p) ?? null;
    expect(unmodifiedStarterEngine(read)).toBe('three');
    tree.set('src/player.js', '// rewritten');
    expect(unmodifiedStarterEngine(read)).toBeNull();
  });
});

describe('draft prompts', () => {
  it('state the real page API and show the read-only engine plus the starter modules', () => {
    const sys = buildDraftSystemPrompt();
    expect(sys).toContain('isDown(actionId)');
    expect(sys).toContain('There is NO controls.active');
    expect(sys).toContain('playerPos');
    const tree = starterTree();
    const user = buildDraftUserPrompt({
      brief: 'a sword fighting game',
      spec: { genre: 'fighting' },
      engine: 'three',
      read: (p) => tree.get(p) ?? null,
    });
    expect(user).toContain('a sword fighting game');
    expect(user).toContain('--- src/engine/core.js (READ-ONLY reference');
    expect(user).toContain('--- src/player.js');
  });
});

describe('isWritableDraftPath', () => {
  it('allows src modules, refuses the engine, the page and path tricks', () => {
    expect(isWritableDraftPath('src/main.js')).toBe(true);
    expect(isWritableDraftPath('src/combat/hit.js')).toBe(true);
    expect(isWritableDraftPath('src/engine/core.js')).toBe(false);
    expect(isWritableDraftPath('index.html')).toBe(false);
    expect(isWritableDraftPath('src/../index.html')).toBe(false);
  });
});

describe('draftGameFromStarter', () => {
  it('writes every usable module and reports them', async () => {
    const tree = starterTree();
    const reply = [block('src/main.js', GOOD_MAIN), block('src/player.js', GOOD_PLAYER)].join(NL);
    const result = await draftGameFromStarter({
      engine: 'three',
      brief: 'a sword fighting game',
      read: (p) => tree.get(p) ?? null,
      write: (p, c) => void tree.set(p, c),
      generate: async () => reply,
    });
    expect(result.written.sort()).toEqual(['src/main.js', 'src/player.js']);
    expect(tree.get('src/player.js')).toContain('class Player');
  });

  it('skips the engine and unsafe paths, but still writes the rest', async () => {
    const tree = starterTree();
    const before = tree.get('src/engine/core.js');
    const reply = [
      block('src/main.js', "import { resetPlayer } from './player.js';"),
      block('src/engine/core.js', `${GOOD_PLAYER} // attempt to replace the engine`),
      block('index.html', `<html>nope</html> ${'x'.repeat(100)}`),
    ].join(NL);
    const result = await draftGameFromStarter({
      engine: 'three',
      brief: 'x',
      read: (p) => tree.get(p) ?? null,
      write: (p, c) => void tree.set(p, c),
      generate: async () => reply,
    });
    expect(result.written).toEqual(['src/main.js']);
    expect(result.skipped.sort()).toEqual(['index.html', 'src/engine/core.js']);
    expect(tree.get('src/engine/core.js')).toBe(before);
  });

  it('throws and writes NOTHING when there is no usable entry module (no half-converted project)', async () => {
    const tree = starterTree();
    const writes: string[] = [];
    await expect(
      draftGameFromStarter({
        engine: 'three',
        brief: 'x',
        read: (p) => tree.get(p) ?? null,
        write: (p) => void writes.push(p),
        generate: async () => block('src/player.js', GOOD_PLAYER),
      }),
    ).rejects.toThrow(/usable src\/main\.js/);
    expect(writes).toEqual([]);
  });
});

describe('draft integrity and creative scope', () => {
  it.each(['three', 'phaser', 'canvas2d'] as const)(
    'uses only the %s engine contract',
    (engine) => {
      const prompt = buildDraftSystemPrompt(engine);
      expect(prompt).toContain('Do not add combat');
      expect(prompt).toContain('open-ended games');
      expect(prompt).toContain('custom playtest contract');
      if (engine !== 'three') {
        expect(prompt).not.toContain('camera.getWorldDirection');
        expect(prompt).not.toContain('hemi, sun, ground');
      }
      if (engine === 'phaser') expect(prompt).toContain('Phaser owns the update/physics loop');
    },
  );

  it('accepts a short complete module without discarding it by byte count', async () => {
    const writes = new Map<string, string>();
    await draftGameFromStarter({
      engine: 'three',
      brief: 'a musical garden',
      read: () => null,
      write: (path, body) => {
        writes.set(path, body);
      },
      generate: async () =>
        block('src/main.js', "import { grow } from './garden.js'; grow();") +
        NL +
        block('src/garden.js', 'export function grow() {}'),
    });
    expect(writes.size).toBe(2);
  });

  it('rejects broken module links before any write and retries with a concrete diagnosis', async () => {
    const writes: string[] = [];
    const prompts: string[] = [];
    await draftGameFromStarter({
      engine: 'three',
      brief: 'a musical garden',
      read: () => null,
      write: (path) => {
        writes.push(path);
      },
      generate: async (_system, user) => {
        prompts.push(user);
        expect(writes).toHaveLength(0);
        return (
          block('src/main.js', "import { grow } from './garden.js'; grow();") +
          NL +
          block(
            'src/garden.js',
            prompts.length === 1 ? 'export const seed = 1;' : 'export function grow() {}',
          )
        );
      },
    });
    expect(prompts[1]).toContain('does not export');
    expect(writes).toEqual(['src/main.js', 'src/garden.js']);
  });

  it('rejects duplicate modules without partially replacing the starter', async () => {
    const writes: string[] = [];
    await expect(
      draftGameFromStarter({
        engine: 'three',
        brief: 'x',
        read: () => null,
        write: (path) => {
          writes.push(path);
        },
        generate: async () =>
          block('src/main.js', 'export const x = 1;') +
          NL +
          block('src/main.js', 'export const x = 2;'),
      }),
    ).rejects.toThrow('duplicate file paths');
    expect(writes).toEqual([]);
  });
});

describe('draftGameFromStarter retry', () => {
  it('retries once, naming the missing entry module, and writes only the accepted reply', async () => {
    const tree = starterTree();
    const prompts: string[] = [];
    const replies = [
      block('src/player.js', GOOD_PLAYER),
      [block('src/main.js', GOOD_MAIN), block('src/player.js', GOOD_PLAYER)].join(NL),
    ];
    const writes: string[] = [];
    const result = await draftGameFromStarter({
      engine: 'three',
      brief: 'a sword fighting game',
      read: (p) => tree.get(p) ?? null,
      write: (p, c) => {
        writes.push(p);
        tree.set(p, c);
      },
      generate: async (_system, user) => {
        prompts.push(user);
        return replies[prompts.length - 1] ?? '';
      },
    });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('no usable src/main.js');
    expect(result.written.sort()).toEqual(['src/main.js', 'src/player.js']);
    // nothing from the rejected first reply was written
    expect(writes).toHaveLength(2);
  });
});

describe('draft prompt carries the design direction', () => {
  it('includes the binding direction and tells the model the stage is a placeholder', () => {
    const tree = starterTree();
    const user = buildDraftUserPrompt({
      brief: 'a sword fighting game',
      spec: undefined,
      engine: 'three',
      direction: 'DESIGN DIRECTION (mandatory - test): CAMERA - side-on',
      read: (p) => tree.get(p) ?? null,
    });
    expect(user).toContain('CAMERA - side-on');
    const sys = buildDraftSystemPrompt();
    expect(sys).toContain('STAGE is a placeholder');
    expect(sys).toContain('hemi, sun, ground');
  });
});

describe('the draft prompt and the camera', () => {
  it('requires movement to be derived from the camera, not from fixed axes', () => {
    const prompt = buildDraftSystemPrompt();
    expect(prompt).toContain('Controls follow the SCREEN');
    expect(prompt).toContain('never hard-code world axes');
  });
});
