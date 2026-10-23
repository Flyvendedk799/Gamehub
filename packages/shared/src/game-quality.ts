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
        value: z.number().optional(),
        epsilon: z.number().nonnegative().optional(),
        label: z.string().optional(),
      }),
    )
    .min(1)
    .max(100),
});

/** Evidence belongs to immutable bytes, never to a mutable project or model claim. */
export const GameQuality = z.object({
  schemaVersion: z.literal(1),
  filesHash: z.string().min(1),
  status: z.enum(['verified', 'needs_fixes', 'unverified']),
  booted: z.boolean(),
  behaviorPassed: z.boolean(),
  issues: z.array(z.string()),
  verificationPlan: VerificationPlan.optional(),
  editVerificationPlan: VerificationPlan.optional(),
  visualEvidence: z
    .array(z.object({ moment: z.enum(['title', 'play']), blobKey: z.string() }))
    .max(2)
    .optional(),
  provider: z.object({ provider: z.string(), modelId: z.string() }).optional(),
});
export type GameQuality = z.infer<typeof GameQuality>;

export function assessGame(input: {
  filesHash: string;
  booted: boolean;
  behaviorPassed: boolean;
  issues: readonly string[];
  forceAccepted: boolean;
}): GameQuality {
  const issues = [...input.issues];
  if (input.forceAccepted) issues.push('The build stopped with unresolved verification issues.');
  const status =
    issues.length > 0
      ? 'needs_fixes'
      : input.booted && input.behaviorPassed
        ? 'verified'
        : 'unverified';
  return {
    schemaVersion: 1,
    filesHash: input.filesHash,
    status,
    booted: input.booted,
    behaviorPassed: input.behaviorPassed,
    issues,
  };
}

/**
 * A version whose boot was actually observed to be clean, whether or not every behaviour check
 * passed. The builder preview shows this one rather than falling back to an older verified build:
 * a play check against a live opponent is stochastic, and three follow-ups in a row that were
 * `needs_fixes` left the preview on a version from before all of them, so every edit looked like it
 * had done nothing. Publishing to the Hub keeps the strict `isVerifiedGame` rule.
 */
export function isBootedGame(quality: unknown, filesHash: string): boolean {
  const parsed = GameQuality.safeParse(quality);
  return parsed.success && parsed.data.filesHash === filesHash && parsed.data.booted;
}

export function isVerifiedGame(quality: unknown, filesHash: string): boolean {
  const parsed = GameQuality.safeParse(quality);
  return (
    parsed.success &&
    parsed.data.filesHash === filesHash &&
    parsed.data.status === 'verified' &&
    parsed.data.booted &&
    parsed.data.behaviorPassed &&
    parsed.data.issues.length === 0
  );
}
