export interface InputMessageContentBlock {
  type?: string;
  text?: string;
  tool_use_id?: string;
  tool_call_id?: string;
  toolCallId?: string;
  id?: string;
  content?: unknown;
  name?: string;
  toolName?: string;
  input?: unknown;
  arguments?: unknown;
}

export interface InputToolCall {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string | unknown;
  };
  name?: string;
}

export interface InputMessage {
  role?: string;
  content?: string | unknown[] | unknown;
  result?: unknown;
  tool_call_id?: string;
  toolCallId?: string;
  id?: string;
  tool_calls?: InputToolCall[];
}

export interface AnthropicContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | string;
  text?: string;
  tool_use_id?: string;
  content?: unknown;
  id?: string;
  name?: string;
  input?: unknown;
}

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicContentBlock[];
}

export type CoalescedAnthropicMessages = Array<AnthropicMessage> & {
  system?: string;
};

/**
 * Normalizes input messages for Anthropic's Messages API:
 * 1. Filters system messages into a top-level system string parameter.
 * 2. Coalesces consecutive tool results or consecutive user messages into single user turns.
 * 3. Enforces strict user/assistant turn alternation.
 */
export function coalesceAnthropicMessages(
  messages: Array<InputMessage>,
): CoalescedAnthropicMessages {
  const systemParts: string[] = [];
  const normalizedTurns: Array<{
    role: 'user' | 'assistant';
    blocks: AnthropicContentBlock[];
  }> = [];

  for (const msg of messages) {
    if (!msg) continue;

    if (msg.role === 'system') {
      const text =
        typeof msg.content === 'string'
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content
                .map((c: unknown) =>
                  typeof c === 'object' && c !== null && 'text' in c
                    ? String((c as { text: unknown }).text)
                    : JSON.stringify(c),
                )
                .join('\n')
            : String(msg.content ?? '');
      if (text.trim().length > 0) {
        systemParts.push(text.trim());
      }
      continue;
    }

    if (msg.role === 'tool' || msg.role === 'toolResult') {
      const toolUseId = String(msg.tool_call_id ?? msg.toolCallId ?? msg.id ?? '');
      const content =
        typeof msg.content === 'string'
          ? msg.content
          : typeof msg.result === 'string'
            ? msg.result
            : JSON.stringify(msg.content ?? msg.result ?? '');
      normalizedTurns.push({
        role: 'user',
        blocks: [
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            content,
          },
        ],
      });
      continue;
    }

    if (msg.role === 'user') {
      const blocks: AnthropicContentBlock[] = [];
      if (typeof msg.content === 'string') {
        blocks.push({ type: 'text', text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const rawItem of msg.content) {
          if (!rawItem) continue;
          const item = rawItem as InputMessageContentBlock;
          if (item.type === 'tool_result' || item.type === 'toolResult') {
            blocks.push({
              type: 'tool_result',
              tool_use_id: String(
                item.tool_use_id ?? item.tool_call_id ?? item.id ?? item.toolCallId ?? '',
              ),
              content: item.content ?? '',
            });
          } else if (item.type === 'text') {
            blocks.push({ type: 'text', text: item.text ?? '' });
          } else {
            blocks.push(item as AnthropicContentBlock);
          }
        }
      }
      normalizedTurns.push({ role: 'user', blocks });
      continue;
    }

    if (msg.role === 'assistant') {
      const blocks: AnthropicContentBlock[] = [];
      if (typeof msg.content === 'string' && msg.content.trim().length > 0) {
        blocks.push({ type: 'text', text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const rawItem of msg.content) {
          if (!rawItem) continue;
          const item = rawItem as InputMessageContentBlock;
          if (item.type === 'text') {
            blocks.push({ type: 'text', text: item.text ?? '' });
          } else if (item.type === 'tool_use' || item.type === 'toolCall') {
            blocks.push({
              type: 'tool_use',
              id: String(item.id ?? item.tool_use_id ?? item.toolCallId ?? ''),
              name: item.name ?? item.toolName ?? 'unknown',
              input: item.input ?? item.arguments ?? {},
            });
          } else {
            blocks.push(item as AnthropicContentBlock);
          }
        }
      }

      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          let input = tc.function?.arguments ?? {};
          if (typeof input === 'string') {
            try {
              input = JSON.parse(input);
            } catch {
              // keep as string if parse fails
            }
          }
          blocks.push({
            type: 'tool_use',
            id: String(tc.id ?? ''),
            name: tc.function?.name ?? tc.name ?? 'unknown',
            input,
          });
        }
      }

      normalizedTurns.push({ role: 'assistant', blocks });
    }
  }

  // Coalesce turns and enforce strict user/assistant turn alternation
  const coalesced: AnthropicMessage[] = [];

  for (const turn of normalizedTurns) {
    if (turn.blocks.length === 0) continue;

    if (coalesced.length === 0) {
      if (turn.role === 'assistant') {
        // First message MUST be user in Anthropic Messages API
        coalesced.push({
          role: 'user',
          content: [{ type: 'text', text: 'Continue' }],
        });
      }
      coalesced.push({
        role: turn.role,
        content: [...turn.blocks],
      });
      continue;
    }

    const last = coalesced[coalesced.length - 1]!;
    if (last.role === turn.role) {
      // Coalesce consecutive turns of same role
      last.content.push(...turn.blocks);
    } else {
      coalesced.push({
        role: turn.role,
        content: [...turn.blocks],
      });
    }
  }

  const result = coalesced as CoalescedAnthropicMessages;
  if (systemParts.length > 0) {
    result.system = systemParts.join('\n\n');
  }

  return result;
}
