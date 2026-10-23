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
  const text = (m?.[1] ?? prompt).trim();
  // A message sent after a paused run is appended to a "# Continuation" recap under this heading.
  // Classifiers and the edit step must see what the user typed, not the recap (a recap quoting
  // "can't see" once classified a combat-readability request as a broken game).
  const marker = "## The user's latest message";
  const at = text.lastIndexOf(marker);
  return at === -1 ? text : text.slice(at + marker.length).trim();
}

/** "Continue building from where you paused." and friends: a resume, not a change request. */
export function isResumeRequest(request: string): boolean {
  return /^\s*(please\s+)?(continue|resume|keep going|carry on)\b/i.test(request);
}
