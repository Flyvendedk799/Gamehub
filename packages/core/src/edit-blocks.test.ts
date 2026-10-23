import { describe, expect, it } from 'vitest';
import { applyHunks, parseEditBlocks, parseSummary } from './edit-blocks.js';

const FILE = [
  'export function strike(d) {',
  '  d.state = "windup";',
  '  d.timer = 0.3;',
  '  return d;',
  '}',
  '',
  'export function block(d) {',
  '  d.state = "block";',
  '  return d;',
  '}',
].join('\n');

const REPLY = [
  '=== SUMMARY ===',
  '- Strikes now chain into a combo.',
  '=== END SUMMARY ===',
  '=== EDIT: src/combat.js ===',
  '<<<<<<< SEARCH',
  '  d.timer = 0.3;',
  '=======',
  '  d.timer = 0.22;',
  '  d.combo = (d.combo ?? 0) + 1;',
  '>>>>>>> REPLACE',
  '=== END EDIT ===',
].join('\n');

describe('parseEditBlocks / parseSummary', () => {
  it('reads the path, every hunk, and the summary', () => {
    const blocks = parseEditBlocks(REPLY);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.path).toBe('src/combat.js');
    expect(blocks[0]?.hunks).toEqual([
      { search: '  d.timer = 0.3;', replace: '  d.timer = 0.22;\n  d.combo = (d.combo ?? 0) + 1;' },
    ]);
    expect(parseSummary(REPLY)).toBe('- Strikes now chain into a combo.');
  });

  it('returns nothing for a whole-file reply', () => {
    expect(parseEditBlocks('=== FILE: src/a.js ===\nx\n=== END FILE ===')).toEqual([]);
    expect(parseSummary('no summary here')).toBeNull();
  });
});

describe('applyHunks', () => {
  it('replaces exactly the named lines and leaves the rest alone', () => {
    const hunks = parseEditBlocks(REPLY)[0]?.hunks ?? [];
    const { content, errors } = applyHunks(FILE, hunks);
    expect(errors).toEqual([]);
    expect(content).toContain('d.timer = 0.22;');
    expect(content).toContain('d.combo = (d.combo ?? 0) + 1;');
    expect(content).toContain('export function block(d)');
    expect(content).not.toContain('0.3');
  });

  it('accepts a match that differs only in indentation', () => {
    const { content, errors } = applyHunks(FILE, [
      { search: 'd.state = "block";', replace: '  d.state = "guard";' },
    ]);
    expect(errors).toEqual([]);
    expect(content).toContain('d.state = "guard";');
    expect(content).not.toContain('"block"');
  });

  it('reports a SEARCH that is not in the file, without changing anything', () => {
    const { content, errors } = applyHunks(FILE, [
      { search: 'd.timer = 9.9;', replace: 'd.timer = 1;' },
    ]);
    expect(content).toBe(FILE);
    expect(errors[0]).toMatch(/not in the file/);
  });

  it('refuses an ambiguous SEARCH and an empty one', () => {
    expect(applyHunks(FILE, [{ search: '  return d;', replace: 'x' }]).errors[0]).toMatch(
      /more than once/,
    );
    expect(applyHunks(FILE, [{ search: '   ', replace: 'x' }]).errors[0]).toMatch(/empty/);
  });

  it('applies hunks in order, so a later hunk can build on an earlier one', () => {
    const { content, errors } = applyHunks(FILE, [
      { search: '  d.timer = 0.3;', replace: '  d.timer = 0.2;' },
      { search: '  d.timer = 0.2;', replace: '  d.timer = 0.1;' },
    ]);
    expect(errors).toEqual([]);
    expect(content).toContain('d.timer = 0.1;');
  });
});
