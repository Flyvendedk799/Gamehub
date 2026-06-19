/**
 * ask_user — pause the build to ask the user ONE clarifying question.
 *
 * When the brief is genuinely underspecified in a way that changes WHAT gets
 * built (not trivia), the agent calls this with a concrete question. The host
 * records it via `onAsk` and pauses the run at the next safe boundary
 * (run-generation feeds the pause through `getContinuationHint`). The builder
 * surfaces the question + an answer box; the user's answer resumes the run,
 * threaded back as the next prompt. Prefer a sensible default over asking.
 *
 * Pattern mirrors set-todos: a thin tool whose only effect is a host callback +
 * a result that tells the agent to stop.
 */

import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';

const AskUserParams = Type.Object({
  question: Type.String({ minLength: 8, maxLength: 400 }),
});

export interface AskUserDetails {
  question: string;
}

/** Host callback fired when the agent asks a question — the host pauses the run
 *  and surfaces the question to the user. Omitted in tests → the tool is inert. */
export type AskUserCallback = (question: string) => void;

export function makeAskUserTool(
  onAsk?: AskUserCallback,
): AgentTool<typeof AskUserParams, AskUserDetails> {
  return {
    name: 'ask_user',
    label: 'Ask user',
    description:
      'Pause and ask the user ONE concrete clarifying question when the brief is ' +
      'genuinely ambiguous in a way that changes what you build (e.g. "Endless ' +
      'or a finish line?", "Should enemies shoot back?", "How many levels?"). ' +
      'The run pauses; the user answers in the builder and the run resumes with ' +
      'their answer. Do NOT ask trivia, yes/no nitpicks, or anything you can pick ' +
      'a sensible default for. After calling this, STOP — emit no further tool ' +
      'calls this turn.',
    parameters: AskUserParams,
    async execute(_toolCallId, params): Promise<AgentToolResult<AskUserDetails>> {
      const question = params.question.trim();
      onAsk?.(question);
      return {
        content: [
          {
            type: 'text',
            text: `Question posed to the user: "${question}". The run will now PAUSE for their answer. Stop here — do not continue building until the user responds.`,
          },
        ],
        details: { question },
      };
    },
  };
}
