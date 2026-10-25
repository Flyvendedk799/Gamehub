import type { GameProductionPlan } from '@playforge/shared';

/** Every milestone is an implementation pass, with the original brief still authoritative. */
export function productionMilestonePrompt(
  brief: string,
  plan: GameProductionPlan,
  index: number,
  failing: ReadonlyArray<{ id: string; failures: ReadonlyArray<string> }> = [],
): string {
  const milestone = plan.milestones[index];
  if (!milestone) throw new Error(`Unknown production milestone ${index}`);
  const selected = plan.systems.filter((system) => milestone.systems.includes(system.id));
  // Said first-hand by the host's own replay of the build so far: fix these as part of this pass.
  const failingBlock =
    failing.length === 0
      ? ''
      : `\n\nThe host just replayed the scenarios on the project as it stands and these FAILED. Resolving them is part of this pass, and each failure below is the host's exact wording:\n${failing
          .map((f) => `- ${f.id}: ${f.failures.slice(0, 4).join(' | ')}`)
          .join('\n')}`;
  return `PRODUCTION MILESTONE ${index + 1}/${plan.milestones.length}: ${milestone.goal}

Original user request (authoritative):
${brief}

Intended player experience: ${plan.experience}
Requirements that the finished game must deliver:
${plan.requirements.map((r) => `- ${r.id} [${r.source}]: ${r.description}\n  Player outcome: ${r.playerOutcome}`).join('\n')}

Systems for this pass:
${selected.map((s) => `- ${s.id}: ${s.purpose}. Integrates with: ${s.dependsOn.join(', ') || 'the bootstrap'}. Requirements: ${s.requirements.join(', ')}`).join('\n')}

Acceptance for this milestone:
${milestone.acceptance.map((a) => `- ${a}`).join('\n')}${failingBlock}

The project already contains the previous milestone. Inspect the actual implementation, identify what is missing against this milestone, then IMPLEMENT it. Preserve working rules and integrate the systems into the running game. A label, menu entry, unreachable module, or test-only counter is not a mechanic. Add real authored content and meaningful consequences where the design calls for them. Do not replace the brief with the starter's loop. Do not reselect the engine, redeclare the spec, or weaken the frozen production plan.

The host will replay every scenario independently from a fresh page after the build, including recovery and all earlier requirements. Use the state field names declared in the plan and expose getters into actual game state. Verify the new mechanics and their integration; keep reset/retry/undo functional. If already implemented, inspect and exercise it rather than adding gratuitous features. Finish with a short account of the changes and any unresolved requirement. This is a build pass, not a request for an audit report.`;
}
