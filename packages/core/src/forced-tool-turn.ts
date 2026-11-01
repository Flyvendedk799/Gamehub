/**
 * Turn-0 "make the model call a tool" for Claude models that refuse to be forced.
 *
 * The agent loop forces `tool_choice: any` with thinking off on its first turn so a long create
 * prompt cannot burn the output budget on reasoning and finish with prose. Sonnet 5.5, Opus 5.5 and
 * Fable 5.1 reject a forced tool choice (the pi-ai patch drops it before it reaches the wire), so on
 * those the same intent has to be carried by the prompt, and — where thinking is always on — by a
 * low effort instead of switching it off.
 */

/** Models whose API returns a 400 for `tool_choice` `any` / `tool`. Mirrors the pi-ai patch. */
export function rejectsForcedToolChoice(modelId: string): boolean {
  return /(sonnet-5[-.]5|opus-5[-.]5|fable-5[-.]1|mythos-5[-.]1)/.test(modelId);
}

/** Models where thinking cannot be turned off; effort is the only control. Mirrors the pi-ai patch. */
export function thinkingAlwaysOn(modelId: string): boolean {
  return /(opus-5[-.]5|fable-5|mythos-5)/.test(modelId);
}

export const FORCE_TOOL_NUDGE =
  'Respond by calling one of your tools now. Do not reply with text alone.';

interface PayloadMessage {
  role?: unknown;
  content?: unknown;
}

/**
 * Append the nudge as a trailing text block on the last user message of an Anthropic request.
 * It lands after the prompt-cache breakpoint, so the cached prefix is unchanged. Returns the same
 * params object; a request that does not end on a user message is left alone.
 */
export function appendToolNudge<T extends { messages?: unknown }>(params: T): T {
  const messages = params.messages;
  if (!Array.isArray(messages)) return params;
  const last = messages[messages.length - 1] as PayloadMessage | undefined;
  if (last === undefined || last.role !== 'user') return params;
  const nudge = { type: 'text', text: FORCE_TOOL_NUDGE };
  if (typeof last.content === 'string') {
    last.content = [{ type: 'text', text: last.content }, nudge];
  } else if (Array.isArray(last.content)) {
    last.content = [...last.content, nudge];
  }
  return params;
}
