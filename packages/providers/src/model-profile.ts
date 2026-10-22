import { getModel } from '@mariozechner/pi-ai';
import type { WireApi } from '@playforge/shared';

export interface ModelProfile {
  reasoning: boolean;
  input: ('text' | 'image')[];
  contextWindow: number;
  maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/** One capability source for agent turns, critique and ordinary completions.
 * Unknown models get conservative budgets; zero cost means unknown, never free.
 */
export function resolveModelProfile(
  provider: string,
  modelId: string,
  wire?: WireApi,
  fallbackReasoning = false,
): ModelProfile {
  const lookup = getModel as (provider: string, id: string) => ModelProfile | undefined;
  const registered =
    lookup(provider, modelId) ??
    (wire === 'openai-codex-responses' ? lookup('openai-codex', modelId) : undefined);
  return {
    reasoning: registered?.reasoning ?? fallbackReasoning,
    input: [...(registered?.input ?? ['text'])],
    contextWindow: registered?.contextWindow ?? 32_768,
    maxTokens: registered?.maxTokens ?? 8_192,
    cost: { ...(registered?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }) },
  };
}
