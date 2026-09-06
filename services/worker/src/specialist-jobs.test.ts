import { describe, expect, it } from 'vitest';
import {
  applySpecialistResults,
  assertSpecialistMayNotDone,
  buildSpecialistJobPlan,
  filterSpecialistWrites,
  specialistsEnabled,
} from './specialist-jobs.js';

describe('S7 specialist-jobs', () => {
  it('plans three specialists when enabled', () => {
    const plan = buildSpecialistJobPlan({
      gameSpecJson: '{"genre":"fps"}',
      engine: 'three',
      enabled: true,
    });
    expect(plan.enabled).toBe(true);
    expect(plan.parentOwnsDone).toBe(true);
    expect(plan.briefs.map((b) => b.kind)).toEqual(['systems', 'art', 'audio']);
  });

  it('is off by default unless PLAYFORGE_SPECIALISTS is set', () => {
    expect(specialistsEnabled({})).toBe(false);
    expect(specialistsEnabled({ PLAYFORGE_SPECIALISTS: '1' })).toBe(true);
  });

  it('sandboxes specialist writes and merges without clobbering index.html from art', () => {
    const base = new Map([['index.html', '<html/>']]);
    const merged = applySpecialistResults(base, [
      {
        kind: 'art',
        files: new Map([
          ['assets/hero.png', 'png'],
          ['index.html', 'hacked'],
          ['../escape.txt', 'nope'],
        ]),
      },
      {
        kind: 'systems',
        files: new Map([['src/main.js', 'console.log(1)']]),
      },
    ]);
    expect(merged.get('index.html')).toBe('<html/>');
    expect(merged.get('assets/hero.png')).toBe('png');
    expect(merged.get('src/main.js')).toBe('console.log(1)');
    expect(merged.has('../escape.txt')).toBe(false);
  });

  it('filters disallowed paths', () => {
    const filtered = filterSpecialistWrites(
      'audio',
      new Map([
        ['assets/audio/hit.wav', 'x'],
        ['src/secret.js', 'y'],
      ]),
    );
    expect([...filtered.keys()]).toEqual(['assets/audio/hit.wav']);
  });

  it('refuses done from a specialist', () => {
    expect(() => assertSpecialistMayNotDone('art', 'done')).toThrow(/cannot call done/);
    expect(() => assertSpecialistMayNotDone('art', 'str_replace_based_edit_tool')).not.toThrow();
  });
});
