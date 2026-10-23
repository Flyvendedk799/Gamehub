/**
 * Rules for the post-draft tool-call budget.
 *
 * After the host drafts a game, the agent loop gets a small fixed allowance to verify and polish
 * (see POST_DRAFT_TOOL_BUDGET in agent.ts). Counting every call against it punished the wrong
 * thing. In run a985c47a, about 40 of the 64 calls were directory listings, file views and
 * searches, most of them failed lookups of a file that did not exist, and the run was cut before
 * it could finish a single repair or call `done`.
 *
 * Reading is cheap and bounded by its own allowance; editing and verifying are what the budget is
 * for. Both numbers are caps, not goals: the total stays bounded, so a model that only ever reads
 * still runs out.
 */

/** Extra calls a read-only tool may make without eating into the post-draft budget. */
export const FREE_INSPECTION_CALLS = 40;

/** Warn the agent this many calls before the cap so it can finish instead of being cut. */
export const WRAP_UP_WARNING_CALLS = 8;

/** True for a call that only looks at the project and changes nothing. */
export function isInspectionCall(
  toolName: string | undefined,
  args: Record<string, unknown> | undefined,
): boolean {
  if (toolName === 'list_files' || toolName === 'set_todos') return true;
  if (toolName === 'str_replace_based_edit_tool') {
    const command = args?.['command'];
    return command === 'view' || command === 'find';
  }
  return false;
}

/** Should the wrap-up reminder go out now? Once, when the cap is near. */
export function shouldWarnWrapUp(remaining: number, alreadyWarned: boolean): boolean {
  return !alreadyWarned && remaining <= WRAP_UP_WARNING_CALLS;
}

/** The steering message that asks the agent to land the run instead of exploring. */
export function wrapUpReminder(remaining: number): string {
  return `[system-reminder] Budget: about ${Math.max(0, remaining)} tool calls left. Stop exploring. Fix only what the last verify_artifact or playtest_game reported, using its exact wording, and do not look for files that list_files does not show. Then run validate_game_scene, playtest_game and call done with a short summary that says what you chose: the world, who the player is, the core loop and the twist.`;
}
