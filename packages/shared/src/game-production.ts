import { z } from 'zod';
import { VerificationPlan } from './verification-plan';

const Id = z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/);
const Text = z.string().min(3).max(800);

/** A game's own rules, rather than its genre, define what must be built and tested. */
export const GameProductionPlan = z
  .object({
    schemaVersion: z.literal(1),
    experience: Text,
    requirements: z
      .array(
        z.object({
          id: Id,
          description: Text,
          source: z.enum(['user', 'design']),
          playerOutcome: Text,
        }),
      )
      .min(1)
      .max(16),
    systems: z
      .array(
        z.object({
          id: Id,
          purpose: Text,
          dependsOn: z.array(Id).max(16),
          requirements: z.array(Id).min(1).max(16),
        }),
      )
      .min(1)
      .max(16),
    // The initial draft is the first milestone. Subsequent milestones get separate build passes.
    milestones: z
      .array(
        z.object({
          id: Id,
          goal: Text,
          systems: z.array(Id).min(1).max(16),
          acceptance: z.array(Text).min(1).max(8),
        }),
      )
      .min(2)
      .max(4),
    scenarios: z
      .array(
        z.object({
          id: Id,
          title: Text,
          purpose: z.enum(['core', 'boundary', 'recovery', 'depth']),
          requirements: z.array(Id).min(1).max(16),
          plan: VerificationPlan,
        }),
      )
      .min(2)
      .max(12),
  })
  .superRefine((plan, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    for (const key of ['requirements', 'systems', 'milestones', 'scenarios'] as const) {
      const ids = plan[key].map((item) => item.id);
      if (new Set(ids).size !== ids.length) issue(`Duplicate ${key} id.`);
    }
    const requirements = new Set(plan.requirements.map((r) => r.id));
    const systems = new Map(plan.systems.map((s) => [s.id, s]));
    for (const item of [...plan.systems, ...plan.scenarios]) {
      for (const id of item.requirements) {
        if (!requirements.has(id)) issue(`${item.id} refers to unknown requirement ${id}.`);
      }
    }
    for (const system of plan.systems) {
      for (const id of system.dependsOn) {
        if (!systems.has(id)) issue(`${system.id} depends on unknown system ${id}.`);
      }
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): void => {
      if (visiting.has(id)) {
        issue(`System dependency cycle at ${id}.`);
        return;
      }
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dep of systems.get(id)?.dependsOn ?? []) visit(dep);
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of systems.keys()) visit(id);
    const scheduled = new Set<string>();
    for (const milestone of plan.milestones) {
      const available = new Set([...scheduled, ...milestone.systems]);
      for (const id of milestone.systems) {
        const system = systems.get(id);
        if (!system) issue(`${milestone.id} names unknown system ${id}.`);
        for (const dep of system?.dependsOn ?? []) {
          if (!available.has(dep))
            issue(`${milestone.id} schedules ${id} before dependency ${dep}.`);
        }
        scheduled.add(id);
      }
    }
    for (const id of systems.keys()) {
      if (!scheduled.has(id)) issue(`System ${id} has no build milestone.`);
    }
    for (const id of requirements) {
      if (!plan.systems.some((s) => s.requirements.includes(id)))
        issue(`Requirement ${id} has no implementation system.`);
      if (!plan.scenarios.some((s) => s.requirements.includes(id)))
        issue(`Requirement ${id} has no behavioral scenario.`);
    }
    if (!plan.requirements.some((r) => r.source === 'user'))
      issue('Preserve at least one explicit user requirement.');
    if (!plan.scenarios.some((s) => s.purpose === 'core'))
      issue('A core interaction scenario is required.');
    if (!plan.scenarios.some((s) => s.purpose === 'recovery'))
      issue('A recovery scenario is required: reset, undo, retry, or return to a usable state.');
    let totalFrames = 0;
    for (const scenario of plan.scenarios) {
      for (const step of scenario.plan.steps)
        totalFrames +=
          step.kind === 'key' ? (step.frames ?? 1) : step.kind === 'wait' ? step.frames : 1;
      for (const predicate of scenario.plan.predicates) {
        if (['eq', 'gt', 'lt'].includes(predicate.op) && predicate.value === undefined)
          issue(`${scenario.id}: ${predicate.op} requires a value.`);
        if ((predicate.op === 'gt' || predicate.op === 'lt') && typeof predicate.value !== 'number')
          issue(`${scenario.id}: ${predicate.op} requires a numeric value.`);
        for (const ref of [predicate.frame, predicate.against]) {
          if (typeof ref === 'object' && ref.step >= scenario.plan.steps.length)
            issue(`${scenario.id}: predicate references a nonexistent step.`);
        }
      }
      // A suite must observe an interaction, not only assert an initial constant.
      if (!scenario.plan.predicates.some((p) => p.frame !== 'baseline' && p.op !== 'unchanged'))
        issue(`${scenario.id}: observe a post-input outcome.`);
    }
    if (totalFrames > 10800)
      issue('Scenario suite exceeds the 180-second input budget (10800 frames).');
  });
export type GameProductionPlan = z.infer<typeof GameProductionPlan>;

export const GameScenarioEvidence = z.object({
  id: Id,
  requirements: z.array(Id),
  status: z.enum(['passed', 'failed', 'unavailable']),
  assertions: z.number().int().nonnegative(),
  observed: z.number().int().nonnegative(),
  failures: z.array(z.string()),
});
export type GameScenarioEvidence = z.infer<typeof GameScenarioEvidence>;
