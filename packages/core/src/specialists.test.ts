import { describe, expect, it } from 'vitest';
import {
  planSpecialists,
  isPathAllowedForSpecialist,
  mergeSpecialistWrites,
} from './specialists.js';

describe('S7 specialists', () => {
  it('plans systems/art/audio briefs with sandboxed paths', () => {
    const briefs = planSpecialists({ gameSpecJson: '{"genre":"fps"}', engine: 'three' });
    expect(briefs.map((b) => b.kind)).toEqual(['systems', 'art', 'audio']);
    expect(briefs.every((b) => b.allowedPathPrefixes.length > 0)).toBe(true);
  });

  it('rejects path escapes from art specialist', () => {
    expect(isPathAllowedForSpecialist('art', 'src/main.js')).toBe(false);
    expect(isPathAllowedForSpecialist('art', 'assets/tex.png')).toBe(true);
  });

  it('merges without letting art overwrite systems entrypoints', () => {
    const base = new Map([['src/main.js', 'BASE']]);
    const merged = mergeSpecialistWrites(base, [
      { kind: 'systems' as const, files: new Map([['src/main.js', 'SYS'], ['src/game.js', 'G']]) },
      { kind: 'art' as const, files: new Map([['src/main.js', 'HACK'], ['assets/a.png', 'PNG']]) },
    ]);
    expect(merged.get('src/main.js')).toBe('SYS');
    expect(merged.get('assets/a.png')).toBe('PNG');
  });
});
