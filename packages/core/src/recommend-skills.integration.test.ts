/**
 * Integration drift-guard (Engine Evolution P3↔P8): every skill the capability
 * recommender can emit MUST exist in the game-skills registry, or the push-model
 * recommendation points the agent at a view_game_feel name that 404s. Exercises
 * the full capability surface against both engines.
 */
import { describe, expect, it } from 'vitest';
import { GAME_SKILLS } from './game-skills/index.js';
import { recommendSkills } from './recommend-skills.js';

describe('recommend-skills ↔ registry alignment', () => {
  const FULL_CAPS = {
    mechanics: ['rhythm', 'animate'],
    controlScheme: 'touch' as const,
    escalates: true,
    hasEnemies: true,
    hasFailState: true,
    hasProgression: true,
    hasNarrative: true,
    hasEconomy: true,
    hasPhysics: true,
    procedural: true,
  };

  it('every recommendable skill exists in the registry for both engines', () => {
    const names = new Set(GAME_SKILLS.map((s) => s.name));
    for (const engine of ['phaser', 'three'] as const) {
      const recs = recommendSkills(FULL_CAPS, engine);
      expect(recs.length, engine).toBeGreaterThan(0);
      for (const rec of recs) {
        expect(names, `${engine}: ${rec.skill}`).toContain(rec.skill);
      }
    }
  });
});
