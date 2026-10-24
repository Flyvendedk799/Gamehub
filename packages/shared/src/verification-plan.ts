import { z } from 'zod';

const Frame = z.union([
  z.literal('final'),
  z.literal('baseline'),
  z.object({ step: z.number().int().nonnegative() }),
]);
export const VerificationPlan = z.object({
  steps: z
    .array(
      z.discriminatedUnion('kind', [
        z.object({
          kind: z.literal('key'),
          code: z.string(),
          frames: z.number().int().positive().max(600).optional(),
        }),
        z.object({ kind: z.literal('mouseMove'), x: z.number(), y: z.number() }),
        z.object({
          kind: z.literal('mouseDown'),
          button: z.number().int().min(0).max(2).optional(),
        }),
        z.object({ kind: z.literal('mouseUp'), button: z.number().int().min(0).max(2).optional() }),
        z.object({ kind: z.literal('wait'), frames: z.number().int().positive().max(600) }),
      ]),
    )
    .min(1)
    .max(100),
  predicates: z
    .array(
      z.object({
        field: z.string().min(1),
        op: z.enum(['increased', 'decreased', 'changed', 'unchanged', 'eq', 'gt', 'lt']),
        frame: Frame.optional(),
        against: Frame.optional(),
        value: z.union([z.number().finite(), z.string(), z.boolean()]).optional(),
        epsilon: z.number().nonnegative().optional(),
        label: z.string().optional(),
      }),
    )
    .min(1)
    .max(100),
});
