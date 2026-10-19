export interface PruneOptions {
  maxTokens?: number;
  preserveTailTurns?: number;
  tokenDensityFactor?: number;
  preserveSignedThinking?: boolean;
  summaryRole?: 'system' | 'user';
}

export interface ThinkingBlockPayload {
  turnIndex: number;
  signature?: string;
  thinking: string;
}

export interface ContextMessageToolCall {
  id?: string | undefined;
  name?: string | undefined;
  toolName?: string | undefined;
  thoughtSignature?: string | undefined;
  function?:
    | {
        name?: string | undefined;
        arguments?: string | unknown | undefined;
      }
    | undefined;
}

export interface ContextMessageContentBlock {
  type?: string | undefined;
  text?: string | undefined;
  id?: string | undefined;
  tool_use_id?: string | undefined;
  tool_call_id?: string | undefined;
  toolCallId?: string | undefined;
  name?: string | undefined;
  toolName?: string | undefined;
  signature?: string | undefined;
  thinkingSignature?: string | undefined;
  thoughtSignature?: string | undefined;
  redacted?: boolean | undefined;
  thinking?: string | undefined;
  content?: unknown;
}

export interface ContextMessage {
  role?: string | undefined;
  content?: string | ContextMessageContentBlock[] | unknown[] | undefined;
  tool_calls?: ContextMessageToolCall[] | undefined;
  tool_call_id?: string | undefined;
  toolCallId?: string | undefined;
  toolCall?: ContextMessageToolCall | undefined;
  thinking?: string | { thinking?: string } | undefined;
  thinkingSignature?: string | undefined;
  signature?: string | undefined;
}

export interface PruneResult {
  messages: Array<ContextMessage>;
  prunedMessages: Array<ContextMessage>;
  extractedThinkingBlocks: Array<ThinkingBlockPayload>;
  estimatedTokens: number;
  originalTokens: number;
}

export function calculateTokens(
  messages: Array<ContextMessage>,
  tokenDensityFactor = 1.35,
): number {
  return Math.ceil(JSON.stringify(messages).length / (4 * tokenDensityFactor));
}

function getToolCalls(msg: ContextMessage): Array<{ id: string; name: string }> {
  const calls: Array<{ id: string; name: string }> = [];
  if (!msg) return calls;

  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      if (tc?.id) {
        const name = tc.function?.name ?? tc.name ?? 'unknown';
        calls.push({ id: String(tc.id), name });
      }
    }
  }

  if (Array.isArray(msg.content)) {
    for (const rawBlock of msg.content) {
      const block = rawBlock as ContextMessageContentBlock | undefined;
      if (block && (block.type === 'tool_use' || block.type === 'toolCall')) {
        const id = block.id ?? block.tool_use_id ?? block.toolCallId;
        const name = block.name ?? block.toolName ?? 'unknown';
        if (id) {
          calls.push({ id: String(id), name });
        }
      }
    }
  }

  if (msg.toolCall?.id) {
    calls.push({
      id: String(msg.toolCall.id),
      name: msg.toolCall.name ?? msg.toolCall.toolName ?? 'unknown',
    });
  }

  return calls;
}

function getToolResultIds(msg: ContextMessage): string[] {
  const ids: string[] = [];
  if (!msg) return ids;

  if (msg.tool_call_id) ids.push(String(msg.tool_call_id));
  if (msg.toolCallId) ids.push(String(msg.toolCallId));

  if (Array.isArray(msg.content)) {
    for (const rawBlock of msg.content) {
      const block = rawBlock as ContextMessageContentBlock | undefined;
      if (block && (block.type === 'tool_result' || block.type === 'toolResult')) {
        const id = block.tool_use_id ?? block.tool_call_id ?? block.id ?? block.toolCallId;
        if (id) ids.push(String(id));
      }
    }
  }

  return ids;
}

function extractThinkingFromMessage(
  msg: ContextMessage,
  turnIndex: number,
  extracted: Array<ThinkingBlockPayload>,
  preserveSignedThinking = false,
): ContextMessage {
  if (!msg || msg.role !== 'assistant') {
    return msg;
  }

  const cloned = { ...msg };

  if (Array.isArray(cloned.content)) {
    const newContent: unknown[] = [];
    for (const rawBlock of cloned.content) {
      const block = rawBlock as ContextMessageContentBlock | undefined;
      if (block && block.type === 'thinking') {
        const signature = block.thinkingSignature ?? block.signature ?? '';
        const thinking = String(block.thinking ?? block.text ?? '');
        const isRedacted = block.redacted === true;
        extracted.push({
          turnIndex,
          signature,
          thinking,
        });
        if (preserveSignedThinking && (signature.length > 0 || isRedacted)) {
          newContent.push(rawBlock);
        }
      } else {
        newContent.push(rawBlock);
      }
    }
    cloned.content = newContent;
  }

  if (cloned.thinking !== undefined) {
    const thinkingObj = cloned.thinking;
    const thinkingText =
      typeof thinkingObj === 'string'
        ? thinkingObj
        : typeof thinkingObj === 'object' && thinkingObj !== null
          ? String(thinkingObj.thinking ?? '')
          : '';
    const signature = String(cloned.thinkingSignature ?? cloned.signature ?? '');
    const isRedacted = (cloned as unknown as { redacted?: boolean }).redacted === true;
    extracted.push({
      turnIndex,
      signature,
      thinking: thinkingText,
    });
    if (!preserveSignedThinking || (signature.length === 0 && !isRedacted)) {
      cloned.thinking = undefined;
      cloned.thinkingSignature = undefined;
    }
  }

  return cloned;
}

export function pruneContextAtomic(
  messages: Array<ContextMessage>,
  options: PruneOptions = {},
): PruneResult {
  const tokenDensityFactor = options.tokenDensityFactor ?? 1.35;
  const preserveTailTurns = options.preserveTailTurns ?? 4;
  const preserveSignedThinking = options.preserveSignedThinking ?? false;
  const summaryRole = options.summaryRole ?? 'system';
  const originalTokens = calculateTokens(messages, tokenDensityFactor);

  if (messages.length <= 2) {
    const extractedThinkingBlocks: Array<ThinkingBlockPayload> = [];
    const processed = messages.map((m, idx) =>
      extractThinkingFromMessage(m, idx, extractedThinkingBlocks, preserveSignedThinking),
    );
    return {
      messages: processed,
      prunedMessages: processed,
      extractedThinkingBlocks,
      estimatedTokens: calculateTokens(processed, tokenDensityFactor),
      originalTokens,
    };
  }

  const extractedThinkingBlocks: Array<ThinkingBlockPayload> = [];
  const processedMessages = messages.map((m, idx) =>
    extractThinkingFromMessage(m, idx, extractedThinkingBlocks, preserveSignedThinking),
  );

  // Dynamically pin system instruction and initial user intent:
  // - Leading system messages (0 or more)
  // - First user message (initial user intent)
  // Assistant messages / tool cycles are NEVER pinned to avoid orphan tool calls
  let pinnedCount = 0;
  let seenUser = false;
  for (let i = 0; i < processedMessages.length; i++) {
    const role = processedMessages[i]?.role;
    if (role === 'system') {
      if (!seenUser) {
        pinnedCount = i + 1;
      } else {
        break;
      }
    } else if (role === 'user') {
      if (!seenUser) {
        seenUser = true;
        pinnedCount = i + 1;
      } else {
        break;
      }
    } else {
      break;
    }
  }
  // Fallback: if no leading system/user messages found, pin index 0
  if (pinnedCount === 0) {
    pinnedCount = Math.min(1, processedMessages.length);
  }

  const pinned = processedMessages.slice(0, pinnedCount);

  // Candidate and tail pool division
  const remainingCount = processedMessages.length - pinnedCount;
  const tailCount = Math.min(preserveTailTurns, remainingCount);
  const tailStartIndex = processedMessages.length - tailCount;

  const candidatePool = processedMessages.slice(pinnedCount, tailStartIndex);
  const tailPool = processedMessages.slice(tailStartIndex);

  const prunedToolCallIds = new Set<string>();
  const compactedCandidate: ContextMessage[] = [];

  for (const msg of candidatePool) {
    if (msg.role === 'assistant') {
      const toolCalls = getToolCalls(msg);
      if (toolCalls.length > 0) {
        for (const tc of toolCalls) {
          prunedToolCallIds.add(tc.id);
        }
        const toolNames = Array.from(new Set(toolCalls.map((tc) => tc.name))).join(', ');
        const summaryText = `[Summary: Executed ${toolCalls.length} tool call(s) including ${toolNames}]`;
        const content =
          summaryRole === 'user' && Array.isArray(msg.content)
            ? [{ type: 'text', text: summaryText }]
            : summaryText;
        compactedCandidate.push({
          role: summaryRole,
          content,
        });
        continue;
      }
    }

    // Check if this candidate message is a tool result corresponding to pruned tool call
    const resIds = getToolResultIds(msg);
    if (resIds.length > 0 && resIds.some((id) => prunedToolCallIds.has(id))) {
      if (msg.role === 'tool' || msg.role === 'toolResult') {
        continue;
      }
      if (Array.isArray(msg.content)) {
        const remainingBlocks = (msg.content as unknown[]).filter((b: unknown) => {
          if (!b || typeof b !== 'object') return true;
          const rec = b as ContextMessageContentBlock;
          if (rec.type !== 'tool_result' && rec.type !== 'toolResult') return true;
          const bId = rec.tool_use_id ?? rec.tool_call_id ?? rec.id ?? rec.toolCallId;
          return !prunedToolCallIds.has(String(bId));
        });
        if (remainingBlocks.length > 0) {
          compactedCandidate.push({ ...msg, content: remainingBlocks });
        }
      }
      continue;
    }

    // Discard orphaned tool results whose tool call was not found
    if (msg.role === 'tool' || msg.role === 'toolResult') {
      const callId = msg.tool_call_id ?? msg.toolCallId;
      if (callId && prunedToolCallIds.has(String(callId))) {
        continue;
      }
    }

    compactedCandidate.push(msg);
  }

  // Also clean up tail pool: discard orphaned tool results whose invocations were pruned
  const cleanedTail: ContextMessage[] = [];
  for (const msg of tailPool) {
    const resIds = getToolResultIds(msg);
    if (resIds.length > 0 && resIds.some((id) => prunedToolCallIds.has(id))) {
      if (msg.role === 'tool' || msg.role === 'toolResult') {
        continue;
      }
      if (Array.isArray(msg.content)) {
        const remainingBlocks = (msg.content as unknown[]).filter((b: unknown) => {
          if (!b || typeof b !== 'object') return true;
          const rec = b as ContextMessageContentBlock;
          if (rec.type !== 'tool_result' && rec.type !== 'toolResult') return true;
          const bId = rec.tool_use_id ?? rec.tool_call_id ?? rec.id ?? rec.toolCallId;
          return !prunedToolCallIds.has(String(bId));
        });
        if (remainingBlocks.length > 0) {
          cleanedTail.push({ ...msg, content: remainingBlocks });
        }
      }
      continue;
    }
    if (msg.role === 'tool' || msg.role === 'toolResult') {
      const callId = msg.tool_call_id ?? msg.toolCallId;
      if (callId && prunedToolCallIds.has(String(callId))) {
        continue;
      }
    }
    cleanedTail.push(msg);
  }

  const finalCandidate = [...compactedCandidate];

  // If maxTokens is specified and we still exceed it, prune oldest candidate messages
  if (options.maxTokens !== undefined) {
    let currentTokens = calculateTokens(
      [...pinned, ...finalCandidate, ...cleanedTail],
      tokenDensityFactor,
    );
    while (finalCandidate.length > 0 && currentTokens > options.maxTokens) {
      finalCandidate.shift();
      currentTokens = calculateTokens(
        [...pinned, ...finalCandidate, ...cleanedTail],
        tokenDensityFactor,
      );
    }
  }

  const resultMessages = [...pinned, ...finalCandidate, ...cleanedTail];
  const estimatedTokens = calculateTokens(resultMessages, tokenDensityFactor);

  return {
    messages: resultMessages,
    prunedMessages: resultMessages,
    extractedThinkingBlocks,
    estimatedTokens,
    originalTokens,
  };
}
