import { describe, expect, it } from 'vitest';
import {
  absentFieldWarning,
  fieldsAbsentFromSource,
  rootOfFieldPath,
  unreadableAssertionNote,
} from './edit-intent-feedback.js';

const files = [
  {
    path: 'src/main.js',
    content: 'window.__game.debug.track({ playerPos: () => p.position, score: () => s });',
  },
  { path: 'README.md', content: 'playerYaw is documented here only' },
];

describe('edit-intent-feedback', () => {
  it('takes the root name of a dotted or indexed path', () => {
    expect(rootOfFieldPath('playerPos.y')).toBe('playerPos');
    expect(rootOfFieldPath('enemies[0].hp')).toBe('enemies');
  });

  it('flags a field that appears nowhere in the source (non-source files do not count)', () => {
    expect(fieldsAbsentFromSource(['playerYaw', 'playerPos.y', 'score'], files)).toEqual([
      'playerYaw',
    ]);
  });

  it('matches whole identifiers only', () => {
    expect(fieldsAbsentFromSource(['pos'], files)).toEqual(['pos']);
  });

  it('warns with the way out, and stays silent when nothing is absent', () => {
    expect(absentFieldWarning([])).toBe('');
    expect(absentFieldWarning(['playerYaw'])).toContain('debug.track({ playerYaw:');
  });

  it('separates an unreadable assertion from a measured failure', () => {
    const unreadable = unreadableAssertionNote([
      { pass: false, fieldPresent: false, predicate: { field: 'playerYaw' } },
    ]);
    expect(unreadable).toContain('`playerYaw` could not be read');
    expect(
      unreadableAssertionNote([{ pass: false, fieldPresent: true, predicate: { field: 'x' } }]),
    ).toBeNull();
  });
});
