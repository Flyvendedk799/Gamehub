import { z } from 'zod';
import { GameProductionPlan, GameScenarioEvidence } from './game-production';
import { VerificationPlan } from './verification-plan';
export { VerificationPlan } from './verification-plan';

/** Evidence belongs to immutable bytes, never to a mutable project or model claim. */
export const GameQuality = z.object({
  schemaVersion: z.literal(1),
  filesHash: z.string().min(1),
  status: z.enum(['verified', 'needs_fixes', 'unverified']),
  booted: z.boolean(),
  behaviorPassed: z.boolean(),
  issues: z.array(z.string()),
  verificationPlan: VerificationPlan.optional(),
  production: z
    .object({
      plan: GameProductionPlan,
      buildPasses: z.number().int().nonnegative(),
      scenarios: z.array(GameScenarioEvidence),
    })
    .optional(),
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
    parsed.data.issues.length === 0 &&
    (!parsed.data.production || hasCompleteProductionEvidence(parsed.data.production))
  );
}

/** Persisted claims cannot hide omitted, duplicated, failed or unreadable scenarios. */
export function hasCompleteProductionEvidence(
  production: NonNullable<GameQuality['production']>,
): boolean {
  if (production.scenarios.length !== production.plan.scenarios.length) return false;
  const evidence = new Map(production.scenarios.map((s) => [s.id, s]));
  if (evidence.size !== production.scenarios.length) return false;
  return production.plan.scenarios.every((scenario) => {
    const result = evidence.get(scenario.id);
    return (
      result?.status === 'passed' &&
      result.failures.length === 0 &&
      result.assertions === scenario.plan.predicates.length &&
      result.observed >= result.assertions &&
      result.requirements.length === scenario.requirements.length &&
      scenario.requirements.every((id) => result.requirements.includes(id))
    );
  });
}
