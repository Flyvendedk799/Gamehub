import { describe, expect, it } from 'vitest';
import { GameProductionPlan } from './game-production';
import { assessGame, isVerifiedGame } from './game-quality';
import { GameSpec, applyGameSpecPatch } from './game-spec';
import { gardenProductionPlan } from './testing/production-fixtures';

describe('production plans', () => {
  it('persists arbitrary non-combat requirements and preserves them on unrelated edits', () => {
    const spec = GameSpec.parse({
      genre: 'other',
      dimensions: '2d',
      perspective: 'fixed_screen',
      cameraKind: 'static',
      primaryInputs: ['mouse'],
      numActors: 0,
      winCondition: '—',
      loseCondition: '—',
      productionPlan: gardenProductionPlan(),
    });
    expect(
      applyGameSpecPatch(spec, { features: { sound: { mute: true } } }).productionPlan,
    ).toEqual(spec.productionPlan);
  });

  it.each([
    [
      'uncovered requirement',
      (p: GameProductionPlan) => {
        p.requirements.push({
          id: 'story',
          source: 'user',
          description: 'Branching story',
          playerOutcome: 'Choices alter the ending',
        });
      },
    ],
    [
      'unknown requirement',
      (p: GameProductionPlan) => {
        p.systems[0]?.requirements.push('missing');
      },
    ],
    [
      'cycle',
      (p: GameProductionPlan) => {
        p.systems[0]?.dependsOn.push('recovery');
      },
    ],
    [
      'duplicate ids',
      (p: GameProductionPlan) => {
        p.requirements.push({ ...p.requirements[0]! });
      },
    ],
    [
      'missing recovery',
      (p: GameProductionPlan) => {
        p.scenarios[1]!.purpose = 'boundary';
      },
    ],
    [
      'no implementation milestone',
      (p: GameProductionPlan) => {
        p.milestones[1]!.systems = ['garden'];
      },
    ],
    [
      'out of range step',
      (p: GameProductionPlan) => {
        p.scenarios[0]!.plan.predicates[0]!.frame = { step: 99 };
      },
    ],
    [
      'unbounded input duration',
      (p: GameProductionPlan) => {
        p.scenarios[0]!.plan.steps = Array.from({ length: 100 }, () => ({
          kind: 'wait',
          frames: 600,
        }));
      },
    ],
  ])('rejects %s before spending a build', (_name, mutate) => {
    const plan = gardenProductionPlan();
    mutate(plan);
    expect(GameProductionPlan.safeParse(plan).success).toBe(false);
  });

  it('does not accept a verified label when scenario evidence is missing or duplicated', () => {
    const quality = assessGame({
      filesHash: 'abc',
      booted: true,
      behaviorPassed: true,
      issues: [],
      forceAccepted: false,
    });
    const plan = gardenProductionPlan();
    quality.production = { plan, buildPasses: 2, scenarios: [] };
    expect(isVerifiedGame(quality, 'abc')).toBe(false);
    quality.production.scenarios = plan.scenarios.map((s) => ({
      id: s.id,
      requirements: s.requirements,
      status: 'passed',
      assertions: s.plan.predicates.length,
      observed: s.plan.predicates.length,
      failures: [],
    }));
    expect(isVerifiedGame(quality, 'abc')).toBe(true);
    quality.production.scenarios[1] = quality.production.scenarios[0]!;
    expect(isVerifiedGame(quality, 'abc')).toBe(false);
  });
});
