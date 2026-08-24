// @vitest-environment happy-dom
/**
 * The vendored `three/engine-core.jsx` artifact.
 *
 * The engine that produces this file lives in its own repository, and this repo
 * commits the emitted result. That means the artifact can go stale, and nothing
 * in the engine's own test suite can notice — so what this repo owes itself is a
 * test of the *contract* it depends on, independent of how the file was made:
 *
 *  1. it satisfies this platform's Three.js validator with zero errors and zero
 *     warnings, which is the check a generated game is held to,
 *  2. it imports nothing but `three`, because a sandboxed iframe with a pinned
 *     import map cannot resolve anything else,
 *  3. it still exports the surface the game-skill catalogue promises.
 *
 * (1) is the reason this test is here rather than in the engine repo: the
 * validator is this platform's, not the engine's. Refresh the artifact with
 * `node packages/core/scripts/sync-engine-skill.mjs`.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getEngineAdapter } from '@playforge/runtime/engines';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = resolve(HERE, 'engine-core.jsx');
const skillSource = readFileSync(SKILL_PATH, 'utf8');

describe('vendored three/engine-core.jsx', () => {
  it('declares where it came from, so a stale copy is traceable', () => {
    expect(skillSource.startsWith('// when_to_use:')).toBe(true);
    expect(skillSource).toContain('GENERATED from engine3d');
  });

  it('imports nothing but three, so it resolves under the pinned import map', () => {
    const imports = [...skillSource.matchAll(/^import\s[^;]*?from\s+'([^']+)';/gm)].map(
      (match) => match[1],
    );
    // Anything else is unresolvable inside the sandbox, and fails as a blank
    // game rather than as an error anyone can read.
    expect(imports).toEqual(['three']);
  });

  it('contains no eval, which the CSP would block anyway', () => {
    expect(skillSource).not.toMatch(/\beval\s*\(/);
  });

  it('exports the surface the catalogue promises', () => {
    for (const symbol of [
      'export function createGame',
      'export function createGameLoop',
      'export function createFrameClock',
      'export function createSystemScheduler',
      'export function createResourceScope',
      'export function createPlayerZeroBridge',
    ]) {
      expect(skillSource).toContain(symbol);
    }
  });

  it('passes the platform Three.js validator as a complete game', () => {
    const threeAdapter = getEngineAdapter('three');
    if (!threeAdapter) throw new Error('three adapter missing from the registry');

    const files = [
      {
        path: 'index.html',
        content: threeAdapter.bootstrap({
          designId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          gameBaseUrl: 'game-files://designs/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/',
        }),
      },
      { path: 'src/engine-core.js', content: skillSource },
      {
        path: 'src/main.js',
        content: [
          "import { createGame } from './engine-core.js';",
          'const game = createGame({ actions: [{ id: "jump", label: "Jump", keys: ["Space"] }] });',
          'game.onSimulate((step) => { void step; });',
          'game.start();',
        ].join('\n'),
      },
    ];

    // Not just "no errors" — no warnings either. A game built on this engine
    // should come out of the validator completely clean.
    expect(threeAdapter.validate(files)).toEqual({ ok: true });
  });

  it('is registered in the skill catalogue', async () => {
    const { GAME_SKILLS } = await import('../index.js');
    const entry = GAME_SKILLS.find((skill) => skill.name === 'three/engine-core.jsx');
    expect(entry).toBeDefined();
    expect(entry?.engine).toBe('three');
    expect(entry?.category).toBe('engine');
  });
});
