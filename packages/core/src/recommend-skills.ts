/**
 * Engine Evolution Phase 3 — skill recommender.
 *
 * Given a game's declared capabilities, recommend the relevant game-skills
 * the agent should review before hand-rolling those systems. This is a PUSH
 * model: instead of the agent re-deriving enemy AI / waves / progression from
 * scratch every generation, it receives a targeted list of skills to consult
 * first.
 *
 * Pure — no IO, no LLM calls. Returns a stable-ordered, de-duped list of
 * SkillRecommendation objects ready for injection into the agent's system
 * prompt via formatRecommendationsForPrompt.
 */

import type { GameCapabilities } from '@playforge/shared';

export interface SkillRecommendation {
  /** Full skill name including engine dir + extension (e.g. 'phaser/wave-spawner.js'). */
  skill: string;
  /** Human-readable rationale — tells the agent WHY this skill is relevant. */
  reason: string;
}

/** Partial capabilities object accepted as input — all fields are optional at
 *  the call-site so the recommender degrades gracefully for novel/sparse specs. */
type PartialCapabilities = Partial<GameCapabilities>;

type Engine = 'phaser' | 'three';

/** Resolve a base skill name to the full path for the given engine. */
function skillPath(engine: Engine, base: string): string {
  const ext = engine === 'phaser' ? '.js' : '.jsx';
  return `${engine}/${base}${ext}`;
}

/**
 * Map a game's declared capabilities to a list of skill recommendations.
 *
 * Rules (applied in stable order; de-duped by skill path):
 *   hasEnemies        → enemy-ai
 *   escalates         → wave-spawner
 *   hasProgression    → level-orchestrator + save-state
 *   procedural        → procedural-gen
 *   hasNarrative      → dialog-flow
 *   hasEconomy        → economy-system
 *   controlScheme in ['touch','drag'] → mobile-controls
 *   mechanics includes any of ['rhythm','beat','music','timing'] → rhythm-clock
 *   mechanics includes any of ['animate','animation','cutscene'] → animation-sequencer
 *
 * Juice skills (screen-shake, hitstop, particle-burst, score-pop, screen-flash)
 * are pull-only and are intentionally excluded here.
 */
export function recommendSkills(
  capabilities: PartialCapabilities,
  engine: Engine,
): SkillRecommendation[] {
  const seen = new Set<string>();
  const recs: SkillRecommendation[] = [];

  function push(base: string, reason: string): void {
    const skill = skillPath(engine, base);
    if (!seen.has(skill)) {
      seen.add(skill);
      recs.push({ skill, reason });
    }
  }

  if (capabilities.hasEnemies === true) {
    push('enemy-ai', "hostile actors need behaviour — don't hand-roll chase/patrol/charge");
  }

  if (capabilities.escalates === true) {
    push('wave-spawner', 'difficulty must ramp — escalating waves + a wave counter');
  }

  if (capabilities.hasProgression === true) {
    push('level-orchestrator', 'levels/stages/unlocks require an orchestrator to sequence them');
    push('save-state', "persistent progress needs serialised save/load — don't hand-roll");
  }

  if (capabilities.procedural === true) {
    push('procedural-gen', 'procedurally generated content needs seeded RNG + layout helpers');
  }

  if (capabilities.hasNarrative === true) {
    push('dialog-flow', 'story/dialogue/cutscenes need a sequenced dialog flow controller');
  }

  if (capabilities.hasEconomy === true) {
    push('economy-system', "currency/resources/shop needs an economy system — don't hand-roll");
  }

  const scheme = capabilities.controlScheme;
  if (scheme === 'touch' || scheme === 'drag') {
    push('mobile-controls', 'touch/drag control scheme needs mobile-optimised input handling');
  }

  const mechanics = capabilities.mechanics ?? [];
  const mechanicsLower = mechanics.map((m) => m.toLowerCase());

  const rhythmKeywords = ['rhythm', 'beat', 'music', 'timing'];
  if (rhythmKeywords.some((kw) => mechanicsLower.some((m) => m.includes(kw)))) {
    push('rhythm-clock', "rhythm/beat mechanics need a precision clock — don't hand-roll timing");
  }

  const animKeywords = ['animate', 'animation', 'cutscene'];
  if (animKeywords.some((kw) => mechanicsLower.some((m) => m.includes(kw)))) {
    push('animation-sequencer', "animation/cutscene mechanics need a sequencer — don't hand-roll");
  }

  return recs;
}

/**
 * Render recommendations as a short bullet list for injection into the agent's
 * system prompt. Returns an empty string when there are no recommendations so
 * the caller can gate on truthiness.
 */
export function formatRecommendationsForPrompt(recs: SkillRecommendation[]): string {
  if (recs.length === 0) return '';
  const bullets = recs
    .map((r) => `- import_skill({ name: '${r.skill}' }) — ${r.reason}`)
    .join('\n');
  return `Recommended skills for this game's capabilities — IMPORT each with import_skill, then call its exports (do NOT hand-roll these systems):\n${bullets}`;
}
