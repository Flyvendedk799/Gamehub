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
  // Looking up the playbook again does not change anything either; it kept resetting the streak.
  if (toolName === 'get_playtest_playbook') return true;
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

/** Tool calls a repair round may make without a single edit before it is told to act. */
export const REPAIR_NUDGE_CALLS = 8;
/** ...and the point at which it is stopped: it is not going to fix anything. */
export const REPAIR_STALL_CALLS = 16;

/** True for a call that changes the project (an editor write), as opposed to looking or checking. */
export function isEditingCall(
  toolName: string | undefined,
  args: Record<string, unknown> | undefined,
): boolean {
  if (toolName === 'import_skill') return true;
  if (toolName !== 'str_replace_based_edit_tool') return false;
  const command = args?.['command'];
  return (
    command === 'create' ||
    command === 'str_replace' ||
    command === 'insert' ||
    command === 'patch' ||
    command === 'delete'
  );
}

/**
 * A repair round exists to change something. Run e229481c's repair spent 2m36s and ~40 calls
 * viewing, searching and re-reading the playbook, and edited nothing; the budget cap eventually
 * ended it, and the re-test passed on the unchanged game. Measured in calls SINCE THE LAST EDIT,
 * so looking things up before a first edit is allowed, within reason, and checking in between
 * edits does not count against it.
 */
export function repairStallAction(
  callsSinceEdit: number,
  isRepairRound: boolean,
): 'none' | 'nudge' | 'stop' {
  if (!isRepairRound) return 'none';
  if (callsSinceEdit >= REPAIR_STALL_CALLS) return 'stop';
  if (callsSinceEdit === REPAIR_NUDGE_CALLS) return 'nudge';
  return 'none';
}

/** The steering message for a repair round that has not edited anything yet. */
export function repairStallReminder(callsSinceEdit: number, changedFiles: string[] = []): string {
  // Run bf3a9e60 spent a whole repair round guessing a file that did not exist while the diff in
  // its first message named the file that changed. Say that file here, in the nudge.
  const where =
    changedFiles.length > 0
      ? ` The host changed ${changedFiles.slice(0, 3).join(', ')}: edit there.`
      : '';
  return `[system-reminder] This is a repair round and you have made ${callsSinceEdit} calls without changing anything. The failing check and the lines the host just changed are in your first message: that is where the cause is.${where} Stop searching. Make ONE targeted str_replace on the most likely cause now. If you truly cannot find it, say what you looked for in one sentence and call done; the host will keep the version that already booted.`;
}
