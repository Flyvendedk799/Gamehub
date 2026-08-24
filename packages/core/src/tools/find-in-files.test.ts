/**
 * `find` exists because the edit tool had no way to answer "where is this".
 *
 * Before it, locating a string meant reading the file — and production traces
 * show agents doing exactly that, walking a 745-line game in overlapping
 * windows at roughly ten seconds a round trip. These tests pin the behaviour
 * that makes one call replace that walk.
 */

import { describe, expect, it } from 'vitest';
import { FIND_HIT_CAP, FIND_MAX_CONTEXT, findInFiles } from './find-in-files.js';

const GAME = {
  path: 'src/main.js',
  content: [
    'import * as THREE from "three";',
    '',
    'const MAX_ENEMIES = 6;',
    '',
    'function spawnEnemy(kind) {',
    '  const mesh = buildBoxer(kind);',
    '  scene.add(mesh);',
    '}',
    '',
    'function waveUpdate(dt) {',
    '  if (enemies.length < MAX_ENEMIES) spawnEnemy("grunt");',
    '}',
  ].join('\n'),
};

const HTML = {
  path: 'index.html',
  content: [
    '<canvas id="game"></canvas>',
    '<script type="module" src="src/main.js"></script>',
  ].join('\n'),
};

describe('findInFiles', () => {
  it('reports every call site with path and line', () => {
    // The question an agent actually has: where is this used? Answered in one
    // call, rather than by reading the file until the answer appears.
    const { text, total } = findInFiles([GAME], 'spawnEnemy', 0);
    expect(total).toBe(2);
    expect(text).toContain('src/main.js:5');
    expect(text).toContain('src/main.js:11');
  });

  it('searches every file, because the answer is often somewhere unread', () => {
    const { text, total } = findInFiles([GAME, HTML], 'src/main.js', 0);
    expect(total).toBe(1);
    expect(text).toContain('index.html:2');
  });

  it('includes surrounding lines and marks the hit', () => {
    const { text } = findInFiles([GAME], 'MAX_ENEMIES', 1);
    expect(text).toContain('>');
    // Context is what makes the result actionable without a follow-up read.
    expect(text).toContain('const MAX_ENEMIES = 6;');
    expect(text).toContain('function waveUpdate(dt) {');
  });

  it('says plainly when there is no match, and how to retry', () => {
    const { text, total } = findInFiles([GAME], 'thisIsNotThere', 2);
    expect(total).toBe(0);
    expect(text).toMatch(/no match/i);
    // A miss must not send the agent back to scanning.
    expect(text).toMatch(/shorter distinctive fragment/i);
  });

  it('matches literally — a regex metacharacter is just a character', () => {
    const file = { path: 'a.js', content: 'const re = /x.*y/;\nconst plain = "x.*y";' };
    const { total } = findInFiles([file], 'x.*y', 0);
    expect(total).toBe(2);
  });

  it('caps a runaway result and says how many were withheld', () => {
    const noisy = {
      path: 'big.js',
      content: Array.from({ length: FIND_HIT_CAP + 25 }, (_, i) => `line ${i} needle`).join('\n'),
    };
    const { text, total } = findInFiles([noisy], 'needle', 0);
    expect(total).toBe(FIND_HIT_CAP + 25);
    expect(text).toContain(`and ${25} more`);
    expect(text).toMatch(/narrow the query/i);
  });

  it('clamps context so one hit cannot dump the file', () => {
    const { text } = findInFiles([GAME], 'spawnEnemy', 9999);
    const contextLines = text.split('\n').filter((l) => /^[> ] +\d+ {2}/.test(l));
    // Two hits, each bounded by the clamp rather than the request.
    expect(contextLines.length).toBeLessThanOrEqual(2 * (FIND_MAX_CONTEXT * 2 + 1));
  });

  it('rejects an empty query rather than matching everything', () => {
    const { text, total } = findInFiles([GAME], '', 2);
    expect(total).toBe(0);
    expect(text).toMatch(/non-empty/);
  });
});
