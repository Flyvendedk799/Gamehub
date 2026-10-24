import { GameProductionPlan } from '../game-production';

/** Small complete plan reused by schema, orchestration and publication regression tests. */
export function gardenProductionPlan(): GameProductionPlan {
  return GameProductionPlan.parse({
    schemaVersion: 1,
    experience: 'Connect plants to compose a living musical garden.',
    requirements: [
      {
        id: 'connect',
        description: 'Connect two plants to make a melody.',
        source: 'user',
        playerOutcome: 'A visible connection plays notes.',
      },
      {
        id: 'reset',
        description: 'Clear the garden and compose again.',
        source: 'design',
        playerOutcome: 'Reset removes connections and stops their notes.',
      },
    ],
    systems: [
      {
        id: 'garden',
        purpose: 'Plant connections and musical rules.',
        dependsOn: [],
        requirements: ['connect'],
      },
      {
        id: 'recovery',
        purpose: 'Clear connections and stop active notes.',
        dependsOn: ['garden'],
        requirements: ['reset'],
      },
    ],
    milestones: [
      {
        id: 'foundation',
        goal: 'Build a playable connected garden.',
        systems: ['garden'],
        acceptance: ['Connecting plants creates a visible and audible melody.'],
      },
      {
        id: 'complete',
        goal: 'Complete the garden lifecycle and feedback.',
        systems: ['recovery'],
        acceptance: ['Reset removes connections and stops all their sounds.'],
      },
    ],
    scenarios: [
      {
        id: 'connect',
        title: 'Create a musical connection',
        purpose: 'core',
        requirements: ['connect'],
        plan: {
          steps: [
            { kind: 'mouseMove', x: 0.5, y: 0.5 },
            { kind: 'mouseDown' },
            { kind: 'mouseUp' },
          ],
          predicates: [{ field: 'connections', op: 'increased' }],
        },
      },
      {
        id: 'reset',
        title: 'Reset the composition',
        purpose: 'recovery',
        requirements: ['reset'],
        plan: {
          steps: [
            { kind: 'mouseDown' },
            { kind: 'mouseUp' },
            { kind: 'key', code: 'KeyR', frames: 1 },
          ],
          predicates: [
            { field: 'connections', op: 'gt', value: 0, frame: { step: 1 } },
            { field: 'connections', op: 'eq', value: 0 },
          ],
        },
      },
    ],
  });
}
