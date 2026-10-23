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
export const FREE_INSPECTION_CALLS = 24;

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

/** Reads in a row, with no edit and no verify between them, before the agent is told to act. */
export const STALLED_READING_CALLS = 12;

/** Nudge once per streak of reads, when it passes the threshold. */
export function shouldNudgeStalledReading(
  consecutiveReads: number,
  alreadyNudged: boolean,
): boolean {
  return !alreadyNudged && consecutiveReads >= STALLED_READING_CALLS;
}

/** Steering message for an agent that keeps reading instead of changing anything. */
export function stalledReadingReminder(consecutiveReads: number): string {
  return `[system-reminder] You have made ${consecutiveReads} read-only calls in a row (view / find / list_files) and changed nothing. More reading will not tell you more: the files you have already viewed are in your context. Decide now. If you know the cause, make the edit with a small str_replace. If the change needs a value the game does not expose (for example a field your edit intent asserts that is missing from window.__game.debug.snapshot()), add it. If you cannot find the code, say what you are looking for in one sentence and use \`find\` with a SHORT fragment across all files — do not page through a file again.`;
}
