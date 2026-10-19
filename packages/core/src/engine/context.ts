export interface PruneOptions {
  maxTokens?: number;
  preserveTailTurns?: number;
  tokenDensityFactor?: number;
}

export interface ThinkingBlockPayload {
  turnIndex: number;
  signature?: string;
  thinking: string;
}

export interface PruneResult {
  messages: Array<any>;
  prunedMessages: Array<any>;
  extractedThinkingBlocks: Array<ThinkingBlockPayload>;
  estimatedTokens: number;
  originalTokens: number;
}

export function calculateTokens(messages: Array<any>, tokenDensityFactor = 1.35): number {
  return Math.ceil(JSON.stringify(messages).length / (4 * tokenDensityFactor));
}

function getToolCalls(msg: any): Array<{ id: string; name: string }> {
  const calls: Array<{ id: string; name: string }> = [];
  if (!msg) return calls;

  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      if (tc && tc.id) {
        const name = tc.function?.name ?? tc.name ?? 'unknown';
        calls.push({ id: String(tc.id), name });
      }
    }
  }

  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block && (block.type === 'tool_use' || block.type === 'toolCall')) {
        const id = block.id ?? block.tool_use_id ?? block.toolCallId;
        const name = block.name ?? block.toolName ?? 'unknown';
        if (id) {
          calls.push({ id: String(id), name });
        }
      }
    }
  }

  if (msg.toolCall && msg.toolCall.id) {
    calls.push({
      id: String(msg.toolCall.id),
      name: msg.toolCall.name ?? msg.toolCall.toolName ?? 'unknown',
    });
  }

  return calls;
}

function getToolResultIds(msg: any): string[] {
  const ids: string[] = [];
  if (!msg) return ids;

  if (msg.tool_call_id) ids.push(String(msg.tool_call_id));
  if (msg.toolCallId) ids.push(String(msg.toolCallId));

  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block && (block.type === 'tool_result' || block.type === 'toolResult')) {
        const id = block.tool_use_id ?? block.tool_call_id ?? block.id ?? block.toolCallId;
        if (id) ids.push(String(id));
      }
    }
  }

  return ids;
}

function extractThinkingFromMessage(
  msg: any,
  turnIndex: number,
  extracted: Array<ThinkingBlockPayload>,
): any {
  if (!msg || msg.role !== 'assistant') {
    return msg;
  }

  const cloned = { ...msg };

  if (Array.isArray(cloned.content)) {
    const newContent: any[] = [];
    for (const block of cloned.content) {
      if (block && block.type === 'thinking') {
        extracted.push({
          turnIndex,
          signature: block.signature ?? '',
          thinking: block.thinking ?? block.text ?? '',
        });
      } else {
        newContent.push(block);
      }
    }
    cloned.content = newContent;
  }

  if (cloned.thinking !== undefined) {
    extracted.push({
      turnIndex,
      signature: cloned.thinkingSignature ?? cloned.signature ?? '',
      thinking: typeof cloned.thinking === 'string' ? cloned.thinking : (cloned.thinking.thinking ?? ''),
    });
    delete cloned.thinking;
    delete cloned.thinkingSignature;
  }

  return cloned;
}

export function pruneContextAtomic(
  messages: Array<any>,
  options: PruneOptions = {},
): PruneResult {
  const tokenDensityFactor = options.tokenDensityFactor ?? 1.35;
  const preserveTailTurns = options.preserveTailTurns ?? 4;
  const originalTokens = calculateTokens(messages, tokenDensityFactor);

  if (messages.length <= 2) {
    const extractedThinkingBlocks: Array<ThinkingBlockPayload> = [];
    const processed = messages.map((m, idx) =>
      extractThinkingFromMessage(m, idx, extractedThinkingBlocks),
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
    extractThinkingFromMessage(m, idx, extractedThinkingBlocks),
  );

  // Pinned: index 0 and 1
  const pinned = processedMessages.slice(0, 2);

  // Tail turns: last `preserveTailTurns`
  const tailCount = Math.min(preserveTailTurns, processedMessages.length - 2);
  const tailStartIndex = processedMessages.length - tailCount;

  const candidatePool = processedMessages.slice(2, tailStartIndex);
  const tailPool = processedMessages.slice(tailStartIndex);

  const prunedToolCallIds = new Set<string>();
  const compactedCandidate: any[] = [];

  for (const msg of candidatePool) {
    if (msg.role === 'assistant') {
      const toolCalls = getToolCalls(msg);
      if (toolCalls.length > 0) {
        for (const tc of toolCalls) {
          prunedToolCallIds.add(tc.id);
        }
        const toolNames = Array.from(new Set(toolCalls.map((tc) => tc.name))).join(', ');
        const summaryText = `[Summary: Executed ${toolCalls.length} tool call(s) including ${toolNames}]`;
        compactedCandidate.push({
          role: 'system',
          content: summaryText,
        });
        continue;
      }
    }

    // Check if this candidate message is a tool result corresponding to pruned tool call
    const resIds = getToolResultIds(msg);
    if (resIds.length > 0 && resIds.some((id) => prunedToolCallIds.has(id))) {
      // If msg has multiple content blocks, filter out matching tool_result blocks
      if (Array.isArray(msg.content)) {
        const remainingBlocks = msg.content.filter((b: any) => {
          if (!b || (b.type !== 'tool_result' && b.type !== 'toolResult')) return true;
          const bId = b.tool_use_id ?? b.tool_call_id ?? b.id ?? b.toolCallId;
          return !prunedToolCallIds.has(String(bId));
        });
        if (remainingBlocks.length > 0) {
          compactedCandidate.push({ ...msg, content: remainingBlocks });
        }
      }
      // If entire message was tool result for pruned tool call, it is discarded
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
  const cleanedTail: any[] = [];
  for (const msg of tailPool) {
    const resIds = getToolResultIds(msg);
    if (resIds.length > 0 && resIds.some((id) => prunedToolCallIds.has(id))) {
      if (Array.isArray(msg.content)) {
        const remainingBlocks = msg.content.filter((b: any) => {
          if (!b || (b.type !== 'tool_result' && b.type !== 'toolResult')) return true;
          const bId = b.tool_use_id ?? b.tool_call_id ?? b.id ?? b.toolCallId;
          return !prunedToolCallIds.has(String(bId));
        });
        if (remainingBlocks.length > 0) {
          cleanedTail.push({ ...msg, content: remainingBlocks });
        }
      }
      continue;
    }
    cleanedTail.push(msg);
  }

  let finalCandidate = [...compactedCandidate];

  // If maxTokens is specified and we still exceed it, prune oldest candidate messages
  if (options.maxTokens !== undefined) {
    while (
      finalCandidate.length > 0 &&
      calculateTokens([...pinned, ...finalCandidate, ...cleanedTail], tokenDensityFactor) >
        options.maxTokens
    ) {
      finalCandidate.shift();
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
