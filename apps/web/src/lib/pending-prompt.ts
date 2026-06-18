/**
 * Pending-prompt handoff across the auth wall (Phase 2.4).
 *
 * When a logged-out visitor submits a prompt on the homepage, we don't want to
 * lose it at the 401 wall. We stash the prompt in sessionStorage, send the user
 * through register/login, and the auth page replays it after a token lands —
 * creating the project + starting the build and routing straight to the
 * builder. sessionStorage (not localStorage) so the handoff is scoped to the
 * tab and naturally clears when the tab closes.
 */

const PENDING_PROMPT_KEY = 'pf_pending_prompt';

export function setPendingPrompt(prompt: string): void {
  if (typeof window === 'undefined') return;
  try {
    sessionStorage.setItem(PENDING_PROMPT_KEY, prompt);
  } catch {
    // sessionStorage may be unavailable (private mode quirks) — degrade to no
    // handoff rather than throwing at the submit boundary.
  }
}

export function hasPendingPrompt(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const value = sessionStorage.getItem(PENDING_PROMPT_KEY);
    return value !== null && value.trim().length > 0;
  } catch {
    return false;
  }
}

/** Reads and clears the pending prompt in one shot (consume-once). */
export function takePendingPrompt(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = sessionStorage.getItem(PENDING_PROMPT_KEY);
    if (value !== null) sessionStorage.removeItem(PENDING_PROMPT_KEY);
    return value && value.trim().length > 0 ? value : null;
  } catch {
    return null;
  }
}

/** Derive a short, safe project name from the first words of a prompt. */
export function deriveProjectName(prompt: string): string {
  return (
    prompt
      .slice(0, 60)
      .replace(/[^a-zA-Z0-9 ]/g, '')
      .trim() || 'My Game'
  );
}
