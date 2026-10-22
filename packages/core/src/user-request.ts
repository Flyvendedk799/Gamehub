/**
 * The user's own words, out of the prompt the worker assembled.
 *
 * For a follow-up on an existing project the worker wraps the message:
 *   "[SYSTEM: You are EDITING ...]\n\n<prompt>\n<what the user typed>\n</prompt>"
 * The edit pipeline and the "did you really change the game?" gate must quote what the user
 * asked, not the instructions around it.
 */
export function extractUserRequest(prompt: string): string {
  const m = /<prompt>\s*([\s\S]*?)\s*<\/prompt>/.exec(prompt);
  return (m?.[1] ?? prompt).trim();
}

/** "Continue building from where you paused." and friends: a resume, not a change request. */
export function isResumeRequest(request: string): boolean {
  return /^\s*(please\s+)?(continue|resume|keep going|carry on)\b/i.test(request);
}
