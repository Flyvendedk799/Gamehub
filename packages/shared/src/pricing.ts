/**
 * Phase 3 — Anthropic pricing table for the implied-cost metric.
 *
 * Why this exists: when a user imports their Claude Code subscription
 * (provider == 'claude-code-imported'), the marginal *cash* cost of a
 * run is $0 — but the budget UI needs to show a meaningful number so
 * users can compare run cost across providers and stay calibrated.
 * The implied cost is what an API user would have paid at standard
 * Anthropic prices for the same token counts.
 *
 * Per the Phase 7 ambition guardrails: we never relabel `cost_usd` to
 * make a UI work. Subscription users see two numbers — actual ($0) and
 * implied (this calculation), each labelled clearly.
 *
 * Prices are USD per million tokens. Source: anthropic.com/pricing as
 * of 2026-06. The default for unrecognised models conservatively maps
 * to Sonnet-4-6 (mid-tier). Update the table when new families ship.
 *
 * Cached input ≈ 0.1× input; cache-creation ≈ 1.25× input.
 */

export interface ModelPricingEntry {
  /** USD per 1M tokens for fresh (uncached) input. */
  inputPerMillion: number;
  /** USD per 1M tokens for cached input (cache hits). */
  cachedInputPerMillion: number;
  /** USD per 1M tokens for cache creation (the surcharge for the first
   *  time a context block is cached). */
  cacheCreationPerMillion: number;
  /** USD per 1M tokens for assistant output. */
  outputPerMillion: number;
}

function deepFreeze<T extends Record<string, unknown>>(obj: T): Readonly<T> {
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (typeof v === 'object' && v !== null) deepFreeze(v as Record<string, unknown>);
  }
  return Object.freeze(obj);
}

/** Pricing keyed by `modelId` (the canonical id used everywhere in
 *  this codebase: 'claude-sonnet-4-6', 'claude-opus-4-7', etc.).
 *  Deep-frozen so accidental mutation of nested entries throws. */
export const ANTHROPIC_PRICING: Readonly<Record<string, ModelPricingEntry>> = deepFreeze({
  // Sonnet family — 3 / 15.
  'claude-sonnet-4-6': {
    inputPerMillion: 3.0,
    cachedInputPerMillion: 0.3,
    cacheCreationPerMillion: 3.75,
    outputPerMillion: 15.0,
  },
  'claude-sonnet-4-5': {
    inputPerMillion: 3.0,
    cachedInputPerMillion: 0.3,
    cacheCreationPerMillion: 3.75,
    outputPerMillion: 15.0,
  },
  // Opus family — top-tier reasoning, 5 / 25 (≈1.67× Sonnet).
  'claude-opus-4-8': {
    inputPerMillion: 5.0,
    cachedInputPerMillion: 0.5,
    cacheCreationPerMillion: 6.25,
    outputPerMillion: 25.0,
  },
  'claude-opus-4-7': {
    inputPerMillion: 5.0,
    cachedInputPerMillion: 0.5,
    cacheCreationPerMillion: 6.25,
    outputPerMillion: 25.0,
  },
  'claude-opus-4-6': {
    inputPerMillion: 5.0,
    cachedInputPerMillion: 0.5,
    cacheCreationPerMillion: 6.25,
    outputPerMillion: 25.0,
  },
  // Fable family — most capable, above Opus tier: 10 / 50.
  'claude-fable-5': {
    inputPerMillion: 10.0,
    cachedInputPerMillion: 1.0,
    cacheCreationPerMillion: 12.5,
    outputPerMillion: 50.0,
  },
  // Haiku family — fast & cheap: 1 / 5.
  'claude-haiku-4-5': {
    inputPerMillion: 1.0,
    cachedInputPerMillion: 0.1,
    cacheCreationPerMillion: 1.25,
    outputPerMillion: 5.0,
  },
});

/**
 * Phase 6 — purchasable credit packs (6.1). A run costs 10 credits, so the
 * smallest pack buys ~10 runs. Prices are USD; `credits` is the ledger delta
 * granted on a confirmed purchase. The catalogue is the single source of truth
 * shared by the API (validates the requested pack id) and the frontend (renders
 * the buy options) so the two can never drift on price or grant size.
 *
 * Frozen so an accidental mutation of a pack throws rather than silently
 * mispricing a purchase.
 */
export interface CreditPack {
  /** Stable identifier the purchase API accepts. */
  id: string;
  /** Credits granted to the ledger when the purchase confirms. */
  credits: number;
  /** Price in USD. */
  priceUsd: number;
}

export const CREDIT_PACKS: readonly CreditPack[] = Object.freeze([
  Object.freeze({ id: 'starter', credits: 100, priceUsd: 5 }),
  Object.freeze({ id: 'builder', credits: 500, priceUsd: 20 }),
  Object.freeze({ id: 'studio', credits: 1500, priceUsd: 50 }),
]);

/** Look up a credit pack by id. Returns undefined for an unknown id so the
 *  purchase route can reject it with a 400 instead of granting nothing. */
export function creditPackById(id: string): CreditPack | undefined {
  return CREDIT_PACKS.find((p) => p.id === id);
}

/** Token-usage shape consumed by `computeImpliedCost`. Matches the columns
 *  on `run_usage` so callers can pass the row directly. */
export interface UsageTokens {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
}

/** Phase 4 / Integration G — context-window sizes per model id, in
 *  tokens. The continuation threshold check (`shouldPauseForContinuation`'s
 *  `context_threshold` rule) divides estimated cumulative input tokens
 *  by this window to compute `contextUsedPct`. Conservative 200k default
 *  (the Haiku-tier window; the frontier Opus/Sonnet/Fable models are now 1M)
 *  for unknown models so a missing pricing entry never silently disables the
 *  threshold. */
export const MODEL_CONTEXT_WINDOWS: Readonly<Record<string, number>> = Object.freeze({
  // Sonnet 4.6 — 1M context at standard pricing
  'claude-sonnet-4-6': 1_000_000,
  'claude-sonnet-4-6[1m]': 1_000_000,
  // Sonnet 4.5 — 200k standard, 1M with the 1M-context beta
  'claude-sonnet-4-5': 200_000,
  // Opus 4.6 / 4.7 / 4.8 — 1M context at standard pricing
  'claude-opus-4-8': 1_000_000,
  'claude-opus-4-8[1m]': 1_000_000,
  'claude-opus-4-7': 1_000_000,
  'claude-opus-4-7[1m]': 1_000_000,
  'claude-opus-4-6': 1_000_000,
  'claude-opus-4-6[1m]': 1_000_000,
  // Fable 5 — 1M context (default == max)
  'claude-fable-5': 1_000_000,
  'claude-fable-5[1m]': 1_000_000,
  // Haiku 4.5 — 200k
  'claude-haiku-4-5': 200_000,
});

/** Lookup the context window for a model id. Falls back to 200k —
 *  the Sonnet/Opus/Haiku default — for unknown models so the
 *  threshold check stays meaningful even on custom models we
 *  haven't catalogued. */
export function contextWindowFor(modelId: string | null | undefined): number {
  const id = modelId ?? '';
  return MODEL_CONTEXT_WINDOWS[id] ?? 200_000;
}

/** Cumulative byte counters the runtime accumulates per-generation
 *  to feed the context-used estimator. Each field grows monotonically
 *  during a run; the estimator divides by 4 to convert bytes → tokens
 *  (the standard ballpark). Tracked separately so a single field's
 *  growth is debuggable in isolation. */
export interface CumulativeContextBytes {
  /** Initial system prompt + user prompt + replayed history at run
   *  start. Snapshot ONCE at chunk_start. */
  initialPromptBytes: number;
  /** Sum of assistant-text streamed via text_delta events. Becomes
   *  next-turn input when pi-agent-core builds the next request. */
  outputBytes: number;
  /** Sum of tool_execution_end result bytes. Tool results land in the
   *  conversation history and become next-turn input. */
  toolResultBytes: number;
}

/** Estimate `contextUsedPct` (0–1) from cumulative byte counts and
 *  a model id. The estimator approximates pi-agent-core's
 *  re-replay-on-every-turn behaviour: at turn N the input ≈
 *  initial + every prior assistant turn + every prior tool result.
 *  All of those have linear running sums.
 *
 *  Bytes-to-tokens uses the standard 4 chars/token ballpark. Returns
 *  a value clamped to [0, 1.5] so a runaway estimate never reads as
 *  negative or absurd; the caller treats > 0.8 as "pause".
 *  Pure function — safe to memoise / test. */
export function estimateContextUsedPct(
  bytes: CumulativeContextBytes,
  modelId: string | null | undefined,
): number {
  const window = contextWindowFor(modelId);
  if (window <= 0) return 0;
  const totalBytes =
    Math.max(0, bytes.initialPromptBytes) +
    Math.max(0, bytes.outputBytes) +
    Math.max(0, bytes.toolResultBytes);
  const tokens = Math.ceil(totalBytes / 4);
  const pct = tokens / window;
  if (!Number.isFinite(pct) || pct < 0) return 0;
  return Math.min(pct, 1.5);
}

/** Compute implied USD cost from token counts and a model id. Falls back
 *  to Sonnet-4-6 pricing for unrecognised models — that's the median tier
 *  and produces a sane "ballpark" rather than $0 (silent zero would
 *  mislead the budget UI). Pure function — safe to memoise / test.
 *
 *  Cached-input tokens are billed at the cached rate, not the full rate.
 *  Cache-creation tokens are billed at the cache-creation rate (which is
 *  higher than fresh input for some providers). The remaining
 *  `inputTokens - cachedInputTokens - cacheCreationInputTokens` is fresh
 *  input billed at the standard rate. */
export function computeImpliedCost(usage: UsageTokens, modelId: string | null | undefined): number {
  const id = modelId ?? '';
  const entry = ANTHROPIC_PRICING[id] ?? ANTHROPIC_PRICING['claude-sonnet-4-6'];
  if (!entry) return 0;
  const cached = Math.max(0, usage.cachedInputTokens);
  const created = Math.max(0, usage.cacheCreationInputTokens);
  const totalIn = Math.max(0, usage.inputTokens);
  const fresh = Math.max(0, totalIn - cached - created);
  const out = Math.max(0, usage.outputTokens);
  const M = 1_000_000;
  return (
    (fresh * entry.inputPerMillion) / M +
    (cached * entry.cachedInputPerMillion) / M +
    (created * entry.cacheCreationPerMillion) / M +
    (out * entry.outputPerMillion) / M
  );
}
