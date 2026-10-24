import { Type } from '@sinclair/typebox';

const Id = Type.String({ pattern: '^[a-z][a-z0-9_-]{0,47}$' });
const Text = Type.String({ minLength: 3, maxLength: 800 });
const Ids = Type.Array(Id, { minItems: 1, maxItems: 16 });
const Frame = Type.Union([
  Type.Literal('baseline'),
  Type.Literal('final'),
  Type.Object({ step: Type.Integer({ minimum: 0 }) }),
]);

/** Tool transport schema; @playforge/shared validates references, cycles and coverage. */
export const ProductionPlanParams = Type.Object({
  schemaVersion: Type.Literal(1),
  experience: Text,
  requirements: Type.Array(
    Type.Object({
      id: Id,
      description: Text,
      source: Type.Union([Type.Literal('user'), Type.Literal('design')]),
      playerOutcome: Text,
    }),
    { minItems: 1, maxItems: 16 },
  ),
  systems: Type.Array(
    Type.Object({
      id: Id,
      purpose: Text,
      dependsOn: Type.Array(Id, { maxItems: 16 }),
      requirements: Ids,
    }),
    { minItems: 1, maxItems: 16 },
  ),
  milestones: Type.Array(
    Type.Object({
      id: Id,
      goal: Text,
      systems: Ids,
      acceptance: Type.Array(Text, { minItems: 1, maxItems: 8 }),
    }),
    { minItems: 2, maxItems: 4 },
  ),
  scenarios: Type.Array(
    Type.Object({
      id: Id,
      title: Text,
      purpose: Type.Union(['core', 'boundary', 'recovery', 'depth'].map((s) => Type.Literal(s))),
      requirements: Ids,
      plan: Type.Object({
        steps: Type.Array(
          Type.Union([
            Type.Object({
              kind: Type.Literal('key'),
              code: Type.String(),
              frames: Type.Optional(Type.Integer({ minimum: 1, maximum: 600 })),
            }),
            Type.Object({
              kind: Type.Literal('wait'),
              frames: Type.Integer({ minimum: 1, maximum: 600 }),
            }),
            Type.Object({
              kind: Type.Literal('mouseMove'),
              x: Type.Number({ minimum: 0, maximum: 1 }),
              y: Type.Number({ minimum: 0, maximum: 1 }),
            }),
            Type.Object({
              kind: Type.Literal('mouseDown'),
              button: Type.Optional(Type.Integer({ minimum: 0, maximum: 2 })),
            }),
            Type.Object({
              kind: Type.Literal('mouseUp'),
              button: Type.Optional(Type.Integer({ minimum: 0, maximum: 2 })),
            }),
          ]),
          { minItems: 1, maxItems: 100 },
        ),
        predicates: Type.Array(
          Type.Object({
            field: Type.String({ minLength: 1 }),
            op: Type.Union(
              ['increased', 'decreased', 'changed', 'unchanged', 'eq', 'gt', 'lt'].map((s) =>
                Type.Literal(s),
              ),
            ),
            frame: Type.Optional(Frame),
            against: Type.Optional(Frame),
            value: Type.Optional(Type.Union([Type.Number(), Type.String(), Type.Boolean()])),
            epsilon: Type.Optional(Type.Number({ minimum: 0 })),
            label: Type.Optional(Type.String()),
          }),
          { minItems: 1, maxItems: 100 },
        ),
      }),
    }),
    { minItems: 2, maxItems: 12 },
  ),
});
