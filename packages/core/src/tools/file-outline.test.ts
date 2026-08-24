/**
 * The file map.
 *
 * An agent cannot see the file it is editing, so without a map its only way to
 * locate code is to read until it appears. Production traces show precisely
 * that: a 745-line game walked in overlapping windows — [160,240] [200,290]
 * [240,320] [295,380] [320,420] — at roughly ten seconds a round trip. Across
 * two full runs there were 96 ranged views and 1 symbol view, because using the
 * precise primitive requires already knowing the name you want.
 *
 * So the map rides along with every view. These tests pin the shape that makes
 * it worth its bytes.
 */

import { describe, expect, it } from 'vitest';
import { fileOutline, renderOutline } from './symbol-extractor.js';

/** A file shaped like real generated game code. */
function gameFile(): string {
  return [
    'import * as THREE from "three";',
    '',
    'const scene = new THREE.Scene();',
    'const MAX_ENEMIES = 6;',
    '',
    'function makeFloorTex() {',
    '  const c = document.createElement("canvas");',
    '  const y = (v) => v * 2;',
    '  return c;',
    '}',
    '',
    'const spawnEnemy = (kind) => {',
    '  const mesh = makeBoxer(kind);',
    '};',
    '',
    'class WaveRunner {',
    '  update(dt) {}',
    '}',
    '',
    'async function tick(dt) {',
    '  spawnEnemy("grunt");',
    '}',
    ...Array.from({ length: 120 }, (_, i) => `// filler ${i}`),
  ].join('\n');
}

describe('fileOutline', () => {
  it('finds declarations of every form used in game code', () => {
    const names = fileOutline(gameFile()).map((e) => e.name);
    expect(names).toContain('makeFloorTex'); // function
    expect(names).toContain('spawnEnemy'); // const arrow
    expect(names).toContain('WaveRunner'); // class
    expect(names).toContain('tick'); // async function
  });

  it('records the line each one starts on', () => {
    const entry = fileOutline(gameFile()).find((e) => e.name === 'spawnEnemy');
    expect(entry?.line).toBe(12);
  });

  it('flags nested declarations, because view symbol only resolves top-level', () => {
    // Getting this wrong sends the agent to `symbol:` for something that will
    // miss — a wasted round trip, which is the whole thing being fixed.
    const outline = fileOutline(
      ['function outer() {', '  const innerHelper = () => 1;', '}'].join('\n'),
    );
    expect(outline.find((e) => e.name === 'outer')?.topLevel).toBe(true);
    expect(outline.find((e) => e.name === 'innerHelper')?.topLevel).toBe(false);
  });

  it('omits scalar constants — they are not navigation targets', () => {
    const names = fileOutline(gameFile()).map((e) => e.name);
    expect(names).not.toContain('MAX_ENEMIES');
    expect(names).not.toContain('scene');
  });

  it('omits one- and two-letter nested bindings, which are noise', () => {
    // Real output was crowded with `y@52*`, `x@92*`, `dz@451*`.
    const names = fileOutline(gameFile()).map((e) => e.name);
    expect(names).not.toContain('y');
  });

  it('keeps the first of a shadowed name', () => {
    const outline = fileOutline(
      ['function draw() {}', 'function other() {', '  const draw = () => {};', '}'].join('\n'),
    );
    expect(outline.filter((e) => e.name === 'draw')).toHaveLength(1);
    expect(outline.find((e) => e.name === 'draw')?.topLevel).toBe(true);
  });
});

describe('renderOutline', () => {
  it('maps a large file compactly', () => {
    const rendered = renderOutline('src/main.js', gameFile());
    expect(rendered).toContain('MAP of src/main.js');
    expect(rendered).toContain('spawnEnemy@12');
    // The whole point is that it is cheap enough to send on every view.
    expect(rendered.length).toBeLessThan(2000);
  });

  it('tells the agent what to do with it', () => {
    const rendered = renderOutline('src/main.js', gameFile());
    expect(rendered).toMatch(/do NOT page through/i);
    expect(rendered).toContain('symbol');
    expect(rendered).toContain('find');
  });

  it('stays silent for a small file, where a map buys nothing', () => {
    const small = ['function a() {}', 'function b() {}'].join('\n');
    expect(renderOutline('small.js', small)).toBe('');
  });

  it('stays silent for a long file with nothing to map', () => {
    const prose = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n');
    expect(renderOutline('notes.txt', prose)).toBe('');
  });

  it('caps a huge outline and says how many were left out', () => {
    // Two lines apiece, to clear the minimum-size threshold as well.
    const many = Array.from({ length: 90 }, (_, i) => `function fn${i}() {\n}`).join('\n');
    const rendered = renderOutline('big.js', many);
    expect(rendered).toMatch(/\+30 more/);
  });
});
