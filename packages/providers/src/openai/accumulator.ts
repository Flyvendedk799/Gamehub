export interface RawToolCallChunk {
  index: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface FinalizedToolCall {
  index: number;
  id: string;
  type: string;
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * Accumulates streaming parallel tool call chunks by index,
 * preventing cross-contamination between interleaved tool call streams.
 */
export class DemuxingToolAccumulator {
  private toolCallsByIndex = new Map<
    number,
    {
      index: number;
      id: string;
      type: string;
      name: string;
      arguments: string;
    }
  >();

  feedChunk(chunk: RawToolCallChunk): void {
    if (!chunk || typeof chunk.index !== 'number') {
      return;
    }

    const idx = chunk.index;
    const existing = this.toolCallsByIndex.get(idx);

    if (!existing) {
      this.toolCallsByIndex.set(idx, {
        index: idx,
        id: chunk.id ?? '',
        type: chunk.type ?? 'function',
        name: chunk.function?.name ?? '',
        arguments: chunk.function?.arguments ?? '',
      });
    } else {
      if (chunk.id) {
        existing.id = chunk.id;
      }
      if (chunk.type) {
        existing.type = chunk.type;
      }
      if (chunk.function?.name) {
        existing.name += chunk.function.name;
      }
      if (chunk.function?.arguments) {
        existing.arguments += chunk.function.arguments;
      }
    }
  }

  finalize(): Array<FinalizedToolCall> {
    const sorted = Array.from(this.toolCallsByIndex.values()).sort((a, b) => a.index - b.index);

    return sorted.map((entry) => ({
      index: entry.index,
      id: entry.id,
      type: entry.type || 'function',
      function: {
        name: entry.name,
        arguments: entry.arguments,
      },
    }));
  }

  reset(): void {
    this.toolCallsByIndex.clear();
  }
}
