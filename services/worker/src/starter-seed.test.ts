/**
 * The seeded premium scaffold, end to end (docs/BUILD_SPEED_FROM_BOXER_RUNS.md §1/§2).
 *
 * Two things this guards that the per-package tests cannot:
 *
 *  1. the module set the agent is handed actually PASSES the engine's own scene
 *     validator — the split into modules must not cost the game its boot;
 *  2. the whole set inlines to ONE self-contained HTML, which is what the
 *     runtime-verify / playtest gate and the publish path both boot. A sibling
 *     import that survives inlining is a module that never loads in the sandbox.
 */
import {
  PREMIUM_STARTER_ENGINE_PATH,
  PREMIUM_STARTER_FILES,
  PREMIUM_STARTER_PATH,
  type StarterEngine,
  starterPathsFor,
} from '@playforge/agent-core';
import { GAME_ENGINE_ADAPTERS } from '@playforge/runtime/engines';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGameHtml } from '../../../packages/exporters/src/index';
import { seedPremiumStarter } from './run-generation';
import { WorkingTree } from './working-tree';

const ENGINES: StarterEngine[] = ['canvas2d', 'phaser', 'three'];

function bootstrapHtml(engine: StarterEngine): string {
  const adapter = GAME_ENGINE_ADAPTERS.get(engine);
  if (adapter === undefined) throw new Error(`no adapter for ${engine}`);
  return adapter.bootstrap({ designId: 'test', gameBaseUrl: 'game-files://designs/test/' });
}

describe('seedPremiumStarter', () => {
  for (const engine of ENGINES) {
    it(`seeds the whole ${engine} module set into an empty tree`, () => {
      const tree = new WorkingTree();
      const seeded = seedPremiumStarter(tree, engine);
      expect(seeded.sort()).toEqual(starterPathsFor(engine).sort());
      expect(tree.view(PREMIUM_STARTER_PATH)).not.toBeNull();
      // §2 — the engine is WRITTEN, not recommended.
      expect(tree.view(PREMIUM_STARTER_ENGINE_PATH)).not.toBeNull();
    });
  }

  it('seeds nothing when an entry module already exists (a remix keeps its game)', () => {
    const tree = new WorkingTree([['src/main.js', "// the user's own game"]]);
    expect(seedPremiumStarter(tree, 'three')).toEqual([]);
    expect(tree.view('src/main.js')?.content).toBe("// the user's own game");
    // Crucially, no scaffold modules are strewn around a project that never
    // imports them — they would only be swept as dead code at ship.
    expect(tree.view(PREMIUM_STARTER_ENGINE_PATH)).toBeNull();
  });

  it('is idempotent — a second seed adds nothing', () => {
    const tree = new WorkingTree();
    expect(seedPremiumStarter(tree, 'phaser').length).toBeGreaterThan(0);
    expect(seedPremiumStarter(tree, 'phaser')).toEqual([]);
  });
});

describe('the seeded scaffold is a real, bootable game', () => {
  for (const engine of ENGINES) {
    it(`${engine} passes its own engine scene validator`, () => {
      const adapter = GAME_ENGINE_ADAPTERS.get(engine);
      if (adapter === undefined) throw new Error(`no adapter for ${engine}`);
      const files = [
        { path: 'index.html', content: bootstrapHtml(engine) },
        ...Object.entries(PREMIUM_STARTER_FILES[engine]).map(([path, content]) => ({
          path,
          content,
        })),
      ];
      const result = adapter.validate(files);
      const errors = result.ok ? [] : result.issues.filter((i) => i.severity === 'error');
      expect(errors, JSON.stringify(errors, null, 2)).toEqual([]);
    });
  }
});

describe('the seeded scaffold survives the inline-for-verify bundler', () => {
  beforeEach(() => {
    // The engine CDN fetch is the only network the bundler does; canvas2d skips it.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, text: () => Promise.resolve('/* engine */') })),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  for (const engine of ENGINES) {
    it(`${engine} inlines to one file with no un-resolved module specifier`, async () => {
      const files = [
        { path: 'index.html', content: bootstrapHtml(engine) },
        ...Object.entries(PREMIUM_STARTER_FILES[engine]).map(([path, content]) => ({
          path,
          content,
        })),
      ];
      const html = await buildGameHtml({ files, engine });

      // Decode every inlined module and confirm none of them still points at a
      // relative sibling — that specifier would 404 in the verify sandbox and the
      // game would boot half-built while reporting a clean load.
      // Breadth-first with a seen-set on the payload: the same module is inlined
      // into several importers, and nesting means each copy re-appears at every
      // level. Without the dedupe the walk is exponential.
      const decoded: string[] = [];
      const seen = new Set<string>();
      const queue: string[] = [html];
      while (queue.length > 0) {
        const current = queue.pop();
        if (current === undefined) continue;
        decoded.push(current);
        for (const m of current.matchAll(/data:text\/javascript;base64,([A-Za-z0-9+/=]+)/g)) {
          const payload = m[1];
          if (payload === undefined || seen.has(payload)) continue;
          seen.add(payload);
          queue.push(Buffer.from(payload, 'base64').toString('utf8'));
        }
      }
      const all = decoded.join('\n');
      for (const path of starterPathsFor(engine)) {
        const base = path.slice(path.lastIndexOf('/') + 1);
        expect(all, `${path} left an un-inlined specifier`).not.toMatch(
          new RegExp(`from '\\.{1,2}/(?:[\\w-]+/)*${base.replace('.', '\\.')}'`),
        );
      }
      // Sanity: the deepest module really made it into the bundle.
      expect(all).toContain('createOscillator');
    });
  }
});
