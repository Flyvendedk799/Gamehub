import { describe, expect, it } from 'vitest';
import {
  GAME_EXAMPLE_BRIEFS,
  briefEngineToApiEngine,
  briefToPrompt,
} from '../example-briefs';

describe('example-briefs (#3.5)', () => {
  it('maps the templates engine spelling to the createProject Engine union', () => {
    expect(briefEngineToApiEngine('three')).toBe('threejs');
    expect(briefEngineToApiEngine('phaser')).toBe('phaser');
  });

  it('every mapped engine is a value createProject accepts', () => {
    const valid = new Set(['phaser', 'threejs', 'vanilla']);
    for (const brief of GAME_EXAMPLE_BRIEFS) {
      expect(valid.has(briefEngineToApiEngine(brief.engine))).toBe(true);
    }
  });

  it('briefToPrompt yields the brief body (the prompt the agent receives)', () => {
    const brief = GAME_EXAMPLE_BRIEFS[0]!;
    expect(briefToPrompt(brief)).toBe(brief.brief);
    expect(briefToPrompt(brief).length).toBeGreaterThan(0);
  });

  it('exposes the real bundled briefs (non-empty, unique slugs)', () => {
    expect(GAME_EXAMPLE_BRIEFS.length).toBeGreaterThan(0);
    const slugs = GAME_EXAMPLE_BRIEFS.map((b) => b.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});
