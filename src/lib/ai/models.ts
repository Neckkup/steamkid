/**
 * The models we are allowed to call, and what they cost.
 *
 * Cost lives here rather than being read back out of Langfuse because we need
 * it at call time: the per-generation `costDetails` we send to Langfuse is what
 * makes "cost per graded item" and "cost per learner per month" answerable in a
 * dashboard instead of in a spreadsheet nobody updates.
 *
 * Prices are USD per 1M tokens, Anthropic first-party API rates. When a price
 * changes, bump `pricingVersion` in the same commit — a cost chart with a silent
 * price change in the middle of it is worse than no chart.
 */

export const PRICING_VERSION = "2026-06-24";

export interface ModelPricing {
  /** USD per 1M input tokens. */
  inputPerMTok: number;
  /** USD per 1M output tokens. */
  outputPerMTok: number;
  /** Cache writes bill at 1.25x input; cache reads at 0.1x input. */
  cacheWriteMultiplier: number;
  cacheReadMultiplier: number;
}

export const MODELS = {
  "claude-opus-5": {
    inputPerMTok: 5,
    outputPerMTok: 25,
    cacheWriteMultiplier: 1.25,
    cacheReadMultiplier: 0.1,
  },
  "claude-sonnet-5": {
    inputPerMTok: 2,
    outputPerMTok: 10,
    cacheWriteMultiplier: 1.25,
    cacheReadMultiplier: 0.1,
  },
  "claude-haiku-4-5": {
    inputPerMTok: 1,
    outputPerMTok: 5,
    cacheWriteMultiplier: 1.25,
    cacheReadMultiplier: 0.1,
  },
} as const satisfies Record<string, ModelPricing>;

export type ModelId = keyof typeof MODELS;

export function isKnownModel(model: string): model is ModelId {
  return model in MODELS;
}

/**
 * Default for anything that grades or gives feedback to a child. Grading
 * quality is the product; a cheaper model is a decision to be made against a
 * measured agreement number on a Langfuse dataset run, not by default.
 */
export const DEFAULT_MODEL: ModelId = "claude-opus-5";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
}

export interface CostBreakdown {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  total: number;
}

/**
 * Cost of one call in USD. Returns `null` for a model we have no price for, so
 * an unpriced model shows up as a missing number rather than as a confident $0.
 */
export function costUsd(model: string, usage: TokenUsage): CostBreakdown | null {
  if (!isKnownModel(model)) return null;
  const price = MODELS[model];

  const perToken = (perMTok: number) => perMTok / 1_000_000;
  const input = usage.inputTokens * perToken(price.inputPerMTok);
  const output = usage.outputTokens * perToken(price.outputPerMTok);
  const cacheWrite =
    (usage.cacheCreationTokens ?? 0) *
    perToken(price.inputPerMTok * price.cacheWriteMultiplier);
  const cacheRead =
    (usage.cacheReadTokens ?? 0) *
    perToken(price.inputPerMTok * price.cacheReadMultiplier);

  return {
    input,
    output,
    cacheWrite,
    cacheRead,
    total: input + output + cacheWrite + cacheRead,
  };
}

/**
 * Langfuse `usageDetails`. `total` is the sum of the non-total keys; Langfuse
 * uses these keys directly for its token charts.
 */
export function usageDetails(usage: TokenUsage): Record<string, number> {
  const details: Record<string, number> = {
    input: usage.inputTokens,
    output: usage.outputTokens,
  };
  if (usage.cacheCreationTokens) details.cache_creation_input = usage.cacheCreationTokens;
  if (usage.cacheReadTokens) details.cache_read_input = usage.cacheReadTokens;
  details.total = Object.values(details).reduce((sum, value) => sum + value, 0);
  return details;
}

/** Langfuse `costDetails`, in USD, matching the `usageDetails` keys. */
export function costDetails(breakdown: CostBreakdown): Record<string, number> {
  return {
    input: breakdown.input,
    output: breakdown.output,
    cache_creation_input: breakdown.cacheWrite,
    cache_read_input: breakdown.cacheRead,
    total: breakdown.total,
  };
}
