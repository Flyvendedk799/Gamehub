import { describe, expect, it } from 'vitest';
import { formatRecommendationsForPrompt, recommendSkills } from './recommend-skills';

describe('recommendSkills', () => {
  it('survival-shooter (phaser): escalates+hasEnemies → wave-spawner + enemy-ai', () => {
    const recs = recommendSkills({ escalates: true, hasEnemies: true }, 'phaser');
    const skills = recs.map((r) => r.skill);
    expect(skills).toContain('phaser/wave-spawner.js');
    expect(skills).toContain('phaser/enemy-ai.js');
  });

  it('three engine: same capabilities yield .jsx names', () => {
    const recs = recommendSkills({ escalates: true, hasEnemies: true }, 'three');
    const skills = recs.map((r) => r.skill);
    expect(skills).toContain('three/wave-spawner.jsx');
    expect(skills).toContain('three/enemy-ai.jsx');
    // Must NOT produce .js names
    expect(skills.some((s) => s.endsWith('.js'))).toBe(false);
  });

  it('narrative game → dialog-flow', () => {
    const recs = recommendSkills({ hasNarrative: true }, 'phaser');
    expect(recs.map((r) => r.skill)).toContain('phaser/dialog-flow.js');
  });

  it('tower-defense ({hasEconomy, hasEnemies, escalates}) → economy-system + enemy-ai + wave-spawner', () => {
    const recs = recommendSkills({ hasEconomy: true, hasEnemies: true, escalates: true }, 'phaser');
    const skills = recs.map((r) => r.skill);
    expect(skills).toContain('phaser/economy-system.js');
    expect(skills).toContain('phaser/enemy-ai.js');
    expect(skills).toContain('phaser/wave-spawner.js');
  });

  it('empty / novel capabilities → no recommendations', () => {
    expect(recommendSkills({}, 'phaser')).toHaveLength(0);
    expect(recommendSkills({}, 'three')).toHaveLength(0);
  });

  it('touch controlScheme → mobile-controls', () => {
    const recs = recommendSkills({ controlScheme: 'touch' }, 'phaser');
    expect(recs.map((r) => r.skill)).toContain('phaser/mobile-controls.js');
  });

  it('drag controlScheme → mobile-controls', () => {
    const recs = recommendSkills({ controlScheme: 'drag' }, 'three');
    expect(recs.map((r) => r.skill)).toContain('three/mobile-controls.jsx');
  });

  it('non-mobile controlScheme (keyboard) → no mobile-controls', () => {
    const recs = recommendSkills({ controlScheme: 'keyboard' }, 'phaser');
    expect(recs.map((r) => r.skill)).not.toContain('phaser/mobile-controls.js');
  });

  it('rhythm mechanic → rhythm-clock (case-insensitive)', () => {
    const recs = recommendSkills({ mechanics: ['Jump', 'Rhythm', 'Shoot'] }, 'phaser');
    expect(recs.map((r) => r.skill)).toContain('phaser/rhythm-clock.js');
  });

  it('beat/music/timing mechanics all trigger rhythm-clock', () => {
    for (const kw of ['beat', 'music', 'timing']) {
      const recs = recommendSkills({ mechanics: [kw] }, 'phaser');
      expect(recs.map((r) => r.skill)).toContain('phaser/rhythm-clock.js');
    }
  });

  it('animation mechanic → animation-sequencer', () => {
    const recs = recommendSkills({ mechanics: ['cutscene'] }, 'phaser');
    expect(recs.map((r) => r.skill)).toContain('phaser/animation-sequencer.js');
  });

  it('de-duplicates: multiple triggers for same skill only yield one entry', () => {
    // hasProgression yields level-orchestrator + cloud-save (v3 P10b prefers
    // cloud-save over device-local save-state for cloud-native progression).
    const recs = recommendSkills({ hasProgression: true }, 'phaser');
    const skills = recs.map((r) => r.skill);
    const unique = new Set(skills);
    expect(skills.length).toBe(unique.size);
    expect(skills).toContain('phaser/level-orchestrator.js');
    expect(skills).toContain('phaser/cloud-save.js');
  });

  it('every recommendation carries a non-empty reason', () => {
    const recs = recommendSkills(
      { hasEnemies: true, escalates: true, hasProgression: true, hasEconomy: true },
      'phaser',
    );
    for (const rec of recs) {
      expect(rec.reason.length).toBeGreaterThan(0);
    }
  });

  it('juice skills are never recommended (no screen-shake, hitstop, etc.)', () => {
    const recs = recommendSkills(
      {
        hasEnemies: true,
        escalates: true,
        hasProgression: true,
        hasEconomy: true,
        hasNarrative: true,
        procedural: true,
        mechanics: ['rhythm', 'animation'],
        controlScheme: 'touch',
      },
      'phaser',
    );
    const juiceNames = ['screen-shake', 'hitstop', 'particle-burst', 'score-pop', 'screen-flash'];
    const skills = recs.map((r) => r.skill);
    for (const juice of juiceNames) {
      expect(skills.some((s) => s.includes(juice))).toBe(false);
    }
  });
});

describe('formatRecommendationsForPrompt', () => {
  it('returns empty string for an empty list', () => {
    expect(formatRecommendationsForPrompt([])).toBe('');
  });

  it('produces a bullet list with the header line', () => {
    const recs = recommendSkills({ hasEnemies: true, escalates: true }, 'phaser');
    const output = formatRecommendationsForPrompt(recs);
    expect(output).toContain('Recommended skills');
    expect(output).toContain('Calling the skill IS how you implement');
    expect(output).toContain('import_skill');
    expect(output).toContain('phaser/enemy-ai.js');
    expect(output).toContain('phaser/wave-spawner.js');
    // Each entry is a bullet
    const lines = output.split('\n').filter((l) => l.startsWith('-'));
    expect(lines.length).toBe(recs.length);
  });

  it('each bullet contains the skill name and reason separated by " — "', () => {
    const recs = recommendSkills({ hasNarrative: true }, 'phaser');
    const output = formatRecommendationsForPrompt(recs);
    const bullet = output
      .split('\n')
      .find((l) => l.startsWith('-') && l.includes('phaser/dialog-flow.js'));
    expect(bullet).toBeDefined();
    expect(bullet).toContain(' — ');
  });
});

describe('recommendSkills — genre-driven (Phase 3 / Loop-2 fixes)', () => {
  it('genre=rhythm with NON-keyword mechanics still recommends rhythm-clock', () => {
    // The Loop-2 miss: mechanics phrased as "hit timed notes" dodged the keyword list.
    const recs = recommendSkills(
      { mechanics: ['hit timed notes', 'judge accuracy'] },
      'phaser',
      'rhythm',
    );
    expect(recs.map((r) => r.skill)).toContain('phaser/rhythm-clock.js');
  });

  it('genre=racing does NOT recommend enemy-ai for its AI opponents (false-positive fix)', () => {
    const recs = recommendSkills({ hasEnemies: true }, 'phaser', 'racing');
    expect(recs.map((r) => r.skill)).not.toContain('phaser/enemy-ai.js');
  });

  it('genre=tower_defense pulls economy + wave + enemy skills from the genre table', () => {
    const recs = recommendSkills({}, 'phaser', 'tower_defense');
    const skills = recs.map((r) => r.skill);
    expect(skills).toContain('phaser/economy-system.js');
    expect(skills).toContain('phaser/wave-spawner.js');
    expect(skills).toContain('phaser/enemy-ai.js');
  });

  it('genre=visual_novel → dialog-flow even with empty capabilities', () => {
    expect(recommendSkills({}, 'three', 'visual_novel').map((r) => r.skill)).toContain(
      'three/dialog-flow.jsx',
    );
  });

  it('no genre passed → behaves as before (capabilities-only)', () => {
    expect(recommendSkills({}, 'phaser')).toHaveLength(0);
  });
});

describe('recommendSkills — P9 asset substrates', () => {
  it('rhythm genre recommends music-sync alongside rhythm-clock', () => {
    const skills = recommendSkills({}, 'phaser', 'rhythm').map((r) => r.skill);
    expect(skills).toContain('phaser/music-sync.js');
    expect(skills).toContain('phaser/rhythm-clock.js');
  });

  it('asset-pipeline is recommended for a 3D combat game on three, NOT on phaser', () => {
    expect(recommendSkills({ hasEnemies: true }, 'three', 'tps').map((r) => r.skill)).toContain(
      'three/asset-pipeline.jsx',
    );
    // phaser has no asset-pipeline skill — must never be recommended there.
    expect(
      recommendSkills({ hasEnemies: true }, 'phaser', 'tps').map((r) => r.skill),
    ).not.toContain('phaser/asset-pipeline.js');
  });
});
