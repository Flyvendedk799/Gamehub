import { describe, expect, it } from 'vitest';
import { GAME_SKILLS } from '../game-skills/index.js';
import { makeListGameFeelTool, makeViewGameFeelTool } from './game-feel-library.js';

/** The eight authored JUICE/FEEL primitives, one per engine. */
const FEEL_TOPICS = [
  'screen-shake',
  'hitstop',
  'particle-burst',
  'squash-stretch',
  'score-pop',
  'screen-flash',
  'knockback',
] as const;

describe('game-feel registry', () => {
  it('surfaces both engines and both categories', () => {
    const engines = new Set(GAME_SKILLS.map((e) => e.engine));
    const categories = new Set(GAME_SKILLS.map((e) => e.category));
    expect(engines).toEqual(new Set(['phaser', 'three']));
    expect(categories).toEqual(new Set(['feel', 'engine']));
  });

  it('includes every authored feel primitive for each engine', () => {
    for (const engine of ['phaser', 'three'] as const) {
      const ext = engine === 'phaser' ? 'js' : 'jsx';
      const names = new Set(
        GAME_SKILLS.filter((e) => e.engine === engine && e.category === 'feel').map((e) => e.name),
      );
      for (const topic of FEEL_TOPICS) {
        expect(names.has(`${engine}/${topic}.${ext}`)).toBe(true);
      }
    }
  });

  it('keeps the previously-dead engine scaffolding discoverable', () => {
    const names = new Set(GAME_SKILLS.map((e) => e.name));
    for (const expected of [
      'phaser/audio-cue.js',
      'phaser/controller.js',
      'phaser/scene-system.js',
      'three/game-loop.jsx',
      'three/controller.jsx',
    ]) {
      expect(names.has(expected)).toBe(true);
    }
  });
});

describe('list_game_feel tool', () => {
  it('returns one entry per snippet with name + engine + category + whenToUse + size', async () => {
    const tool = makeListGameFeelTool();
    const res = await tool.execute('test', {});
    // 7 feel + 6 scaffolding per engine = at least 1 snippet, in practice 26.
    expect(res.details.skills.length).toBeGreaterThanOrEqual(1);
    expect(res.details.skills.length).toBe(GAME_SKILLS.length);
    for (const skill of res.details.skills) {
      expect(skill.name.length).toBeGreaterThan(0);
      expect(['phaser', 'three']).toContain(skill.engine);
      expect(['feel', 'engine']).toContain(skill.category);
      expect(skill.sizeBytes).toBeGreaterThan(0);
      expect(skill.whenToUse.length).toBeGreaterThan(0);
    }
  });

  it('filters by engine', async () => {
    const tool = makeListGameFeelTool();
    const res = await tool.execute('test', { engine: 'phaser' });
    expect(res.details.skills.length).toBeGreaterThanOrEqual(1);
    for (const skill of res.details.skills) {
      expect(skill.engine).toBe('phaser');
    }
  });

  it('filters by category to the feel primitives', async () => {
    const tool = makeListGameFeelTool();
    const res = await tool.execute('test', { engine: 'three', category: 'feel' });
    expect(res.details.skills.length).toBe(FEEL_TOPICS.length);
    for (const skill of res.details.skills) {
      expect(skill.engine).toBe('three');
      expect(skill.category).toBe('feel');
    }
  });

  it('parses the leading // when_to_use: comment block', async () => {
    const tool = makeListGameFeelTool();
    const res = await tool.execute('test', { engine: 'phaser', category: 'feel' });
    const shake = res.details.skills.find((s) => s.name === 'phaser/screen-shake.js');
    expect(shake).toBeDefined();
    expect(shake?.whenToUse.toLowerCase()).toContain('shake');
  });

  it('formats text content as a labelled catalogue', async () => {
    const tool = makeListGameFeelTool();
    const res = await tool.execute('test', { engine: 'phaser', category: 'feel' });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toMatch(/^Game-feel library:/);
    expect(text).toContain('phaser/screen-shake.js [phaser/feel]');
  });
});

describe('view_game_feel tool', () => {
  it('returns the full source of a known snippet', async () => {
    const tool = makeViewGameFeelTool();
    const res = await tool.execute('test', { name: 'phaser/hitstop.js' });
    expect(res.details.name).toBe('phaser/hitstop.js');
    expect(res.details.engine).toBe('phaser');
    expect(res.details.category).toBe('feel');
    expect(res.details.source.length).toBeGreaterThan(100);
    expect(res.details.source).toContain('when_to_use');
    expect(res.details.source).toContain('hitstop');
  });

  it('returns framework-correct Three.js source for a three primitive', async () => {
    const tool = makeViewGameFeelTool();
    const res = await tool.execute('test', { name: 'three/screen-shake.jsx' });
    expect(res.details.engine).toBe('three');
    expect(res.details.source).toContain("import * as THREE from 'three'");
  });

  it('throws with valid-names listing when the snippet is unknown', async () => {
    const tool = makeViewGameFeelTool();
    await expect(tool.execute('test', { name: 'nope/nothing.js' })).rejects.toThrow(
      /Unknown game-feel snippet.*Available:/,
    );
  });
});
