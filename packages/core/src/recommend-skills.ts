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
  genre?: string,
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

  // enemy-ai for combat actors — but NOT racing, whose "enemies" are AI opponents
  // that follow the track, not chase the player (a Loop-2 false-positive).
  if (capabilities.hasEnemies === true && genre !== 'racing') {
    push('enemy-ai', "hostile actors need behaviour — don't hand-roll chase/patrol/charge");
  }

  if (capabilities.escalates === true) {
    push('wave-spawner', 'difficulty must ramp — escalating waves + a wave counter');
  }

  if (capabilities.hasProgression === true) {
    push('level-orchestrator', 'levels/stages/unlocks require an orchestrator to sequence them');
    // v3 P10b — prefer cloud-save: projects are cloud-native, so meta-progression
    // should persist per-account/cross-device, not in device-local localStorage.
    push(
      'cloud-save',
      'persistent progress should persist per-account/cross-device, not device-local',
    );
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

  // Widened synonym/stem sets (Loop-2: rhythm games phrase mechanics as "hit
  // timed notes"/"judge accuracy" and dodged the narrow keyword list).
  const rhythmKeywords = [
    'rhythm',
    'beat',
    'music',
    'timing',
    'tempo',
    'note',
    'combo',
    'judge',
    'lane',
    'sync',
  ];
  if (rhythmKeywords.some((kw) => mechanicsLower.some((m) => m.includes(kw)))) {
    push('rhythm-clock', "rhythm/beat mechanics need a precision clock — don't hand-roll timing");
    push('music-sync', 'lock timing to a REAL audio track (bpm/beatmap), not a synthetic clock');
  }

  const animKeywords = ['animate', 'animation', 'cutscene', 'sequence', 'choreograph', 'scripted'];
  if (animKeywords.some((kw) => mechanicsLower.some((m) => m.includes(kw)))) {
    push('animation-sequencer', "animation/cutscene mechanics need a sequencer — don't hand-roll");
  }

  // Genre-driven canonical skills (Phase 3) — the declared genre is a strong
  // signal the capability phrasing can miss, so fire the genre's canonical skills
  // even when the mechanic keywords didn't match. push() de-dupes.
  const GENRE_SKILLS: Record<string, ReadonlyArray<readonly [string, string]>> = {
    rhythm: [
      ['rhythm-clock', 'rhythm games need a precision music clock + judgment windows'],
      ['music-sync', 'sync to a real audio track so notes line up with the music'],
    ],
    tower_defense: [
      ['economy-system', 'tower-defense needs currency + buildable/upgrade costs'],
      ['wave-spawner', 'tower-defense waves must escalate'],
      ['enemy-ai', 'creeps need pathing/behaviour'],
    ],
    visual_novel: [
      [
        'dialog-flow',
        'visual novels need a branching dialogue runner — forward its lineIndex/choicesMade as the EXACT verdict fields: window.__game.debug.track({ dialogueIndex: () => currentLineIndex, choiceCount: () => choicesMade })',
      ],
    ],
    roguelike: [['procedural-gen', 'roguelikes need seeded procedural layout']],
    shmup: [
      ['enemy-ai', 'shmup enemies need movement patterns'],
      ['wave-spawner', 'shmup difficulty must ramp in waves'],
    ],
    idle: [
      [
        'economy-system',
        'idle/incremental is an economy at its core — expose its balance as the EXACT verdict field `credits` (NOT score/money) plus a rate: window.__game.debug.track({ credits: () => credits, rate: () => perSecond })',
      ],
      [
        'cloud-save',
        'idle progress must persist per-account/cross-device (cloud-native), not device-local',
      ],
    ],
  };
  const genreEntries = genre ? GENRE_SKILLS[genre] : undefined;
  if (genreEntries) {
    for (const [base, reason] of genreEntries) push(base, reason);
  }

  // asset-pipeline is Three-only (glTF models + instanced geometry). Recommend it
  // for 3D games that would otherwise be boxes-and-spheres (combat/3rd-/1st-person).
  if (
    engine === 'three' &&
    (capabilities.hasEnemies === true ||
      genre === 'tps' ||
      genre === 'fps' ||
      genre === 'roguelike')
  ) {
    push('asset-pipeline', 'load real glTF models + instanced geometry instead of primitives');
  }

  return recs;
}

/**
 * Render recommendations as a short bullet list for injection into the agent's
 * system prompt. Returns an empty string when there are no recommendations so
 * the caller can gate on truthiness.
 */
/** How many recommendations are presented as "import now" (core) before the rest
 *  drop to an "also available" tier. v3 P5: a long flat list invites
 *  stage-everything-then-wire-nothing; the recs are emitted core-first. */
export const IMPORT_NOW_TIER_SIZE = 3;

export function formatRecommendationsForPrompt(recs: SkillRecommendation[]): string {
  if (recs.length === 0) return '';
  const fmt = (r: SkillRecommendation) => `- import_skill({ name: '${r.skill}' }) — ${r.reason}`;
  const importNow = recs.slice(0, IMPORT_NOW_TIER_SIZE);
  const also = recs.slice(IMPORT_NOW_TIER_SIZE);
  let out = `Recommended skills — vetted, tested implementations of THIS game's core systems. After you scaffold your entry file, import_skill each one (it wires the import into src/main.js), then BUILD that system by CALLING its exports. Calling the skill IS how you implement that system — do NOT write your own parallel version of what you imported:\n${importNow
    .map(fmt)
    .join('\n')}`;
  if (also.length > 0) {
    out += `\n\nAlso available (import if you build that system):\n${also.map(fmt).join('\n')}`;
  }
  return out;
}
