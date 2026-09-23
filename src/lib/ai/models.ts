/**
 * The models we are allowed to call, and what they cost.
 *
 * Provider: the Gemini API (see `docs/adr/0004-llm-provider-gemini.md`).
 *
 * Cost lives here rather than being read back out of Langfuse because we need
 * it at call time: the per-generation `costDetails` we send to Langfuse is what
 * makes "cost per graded item" and "cost per learner per month" answerable in a
 * dashboard instead of in a spreadsheet nobody updates.
 *
 * Prices are USD per 1M tokens, Gemini API **paid tier**, text modality. Three
 * things about Gemini pricing that this file models on purpose, because getting
 * any of them wrong silently under-reports spend:
 *
 * 1. **Thinking tokens bill at the output rate.** `thoughtsTokenCount` is not
 *    included in `candidatesTokenCount`, so a naive in/out reading of the usage
 *    metadata misses most of the cost of a reasoning call.
 * 2. **Prices are dated.** `gemini-3.8-flash` doubles on 2027-01-01. A rate card
 *    carries the date it takes effect, so the cost charted for a call in
 *    December stays the price we actually paid in December.
 * 3. **Some models have a long-context tier.** Above the prompt-token threshold
 *    every rate changes, so the threshold is priced rather than ignored.
 *
 * When a price changes, bump `PRICING_VERSION` in the same commit — a cost chart
 * with a silent price change in the middle of it is worse than no chart.
 */

import { ThinkingLevel } from "@google/genai";

export const PRICING_VERSION = "2026-09-18";

/** One set of rates, valid from `effectiveFrom` until the next card starts. */
export interface RateCard {
  /** ISO date this card starts applying (UTC, inclusive). */
  effectiveFrom: string;
  /** USD per 1M non-cached prompt tokens. */
  inputPerMTok: number;
  /** USD per 1M output tokens. Thinking tokens bill at this rate too. */
  outputPerMTok: number;
  /** USD per 1M prompt tokens served from cache. */
  cachedInputPerMTok: number;
  /** Rates once the prompt exceeds `longContextThresholdTokens`. */
  long?: {
    inputPerMTok: number;
    outputPerMTok: number;
    cachedInputPerMTok: number;
  };
}

/**
 * How a model's reasoning effort is controlled. Gemini 3.x takes a coarse
 * `thinkingLevel`; the 2.5 family takes a `thinkingBudget` in tokens. Prompts
 * declare an abstract `effort` and this decides what actually goes on the wire.
 */
export type ThinkingControl = "level" | "budget";

export interface ModelPricing {
  rates: RateCard[];
  /** Prompt tokens above which the `long` rates apply. */
  longContextThresholdTokens?: number;
  thinkingControl: ThinkingControl;
  /**
   * Smallest thinking budget the model accepts. `gemini-2.5-pro` cannot turn
   * thinking off, so a `minimal` prompt is clamped here rather than rejected by
   * the API mid-grade.
   */
  minThinkingBudget?: number;
}

/**
 * Registered models. Audio input bills at a higher rate on the Flash models; we
 * send text only, and a non-text feature must add its own rate card before it
 * ships rather than quietly charting the text price.
 */
export const MODELS = {
  /**
   * Default for grading and feedback. Stable, the most capable Flash tier, and
   * cheaper per token than `gemini-2.5-pro`.
   */
  "gemini-3.8-flash": {
    thinkingControl: "level",
    rates: [
      {
        effectiveFrom: "2026-01-01",
        inputPerMTok: 0.75,
        outputPerMTok: 3.75,
        cachedInputPerMTok: 0.075,
      },
      // Google's published increase. Recorded now so the December→January jump
      // shows up as a price change we planned for, not as a billing surprise.
      {
        effectiveFrom: "2027-01-01",
        inputPerMTok: 1.5,
        outputPerMTok: 7.5,
        cachedInputPerMTok: 0.15,
      },
    ],
  },

  /** High-volume, low-stakes classification (behaviour tagging, routing). */
  "gemini-3.1-flash-lite": {
    thinkingControl: "level",
    rates: [
      {
        effectiveFrom: "2026-01-01",
        inputPerMTok: 0.25,
        outputPerMTok: 1.5,
        cachedInputPerMTok: 0.025,
      },
    ],
  },

  /**
   * The deep-reasoning escalation, kept registered so a grading A/B against it
   * is a prompt-version change rather than a code change. Note the long-context
   * tier above 200k prompt tokens.
   */
  "gemini-2.5-pro": {
    thinkingControl: "budget",
    minThinkingBudget: 128,
    longContextThresholdTokens: 200_000,
    rates: [
      {
        effectiveFrom: "2026-01-01",
        inputPerMTok: 1.25,
        outputPerMTok: 10,
        cachedInputPerMTok: 0.125,
        long: { inputPerMTok: 2.5, outputPerMTok: 15, cachedInputPerMTok: 0.25 },
      },
    ],
  },

  /** The cheapest thing that can answer; used by the observability canary. */
  "gemini-2.5-flash-lite": {
    thinkingControl: "budget",
    rates: [
      {
        effectiveFrom: "2026-01-01",
        inputPerMTok: 0.1,
        outputPerMTok: 0.4,
        cachedInputPerMTok: 0.01,
      },
    ],
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
export const DEFAULT_MODEL: ModelId = "gemini-3.8-flash";

/**
 * Reasoning effort, as a prompt declares it. Deliberately the Gemini thinking
 * levels rather than a house vocabulary — an extra translation layer over a
 * provider concept buys nothing and hides what was actually requested.
 */
export const EFFORT_LEVELS = ["minimal", "low", "medium", "high"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

/** `thinkingBudget` in tokens for the 2.5 family, which has no thinking level. */
const EFFORT_TO_BUDGET: Record<Effort, number> = {
  minimal: 0,
  low: 1024,
  medium: 8192,
  high: 24576,
};

const EFFORT_TO_LEVEL: Record<Effort, ThinkingLevel> = {
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

export type ThinkingSettings =
  | { thinkingLevel: ThinkingLevel }
  | { thinkingBudget: number };

/**
 * Translate a prompt's declared effort into this model's thinking control.
 *
 * Returns `null` when the prompt declares no effort, which leaves the model's
 * own default in place — that is a different thing from asking for `minimal`,
 * and conflating them would silently change the quality of every existing
 * prompt version.
 */
export function thinkingSettings(
  model: ModelId,
  effort: Effort | undefined,
): ThinkingSettings | null {
  if (!effort) return null;
  const spec = MODELS[model] as ModelPricing;

  if (spec.thinkingControl === "level") {
    return { thinkingLevel: EFFORT_TO_LEVEL[effort] };
  }

  const budget = Math.max(EFFORT_TO_BUDGET[effort], spec.minThinkingBudget ?? 0);
  return { thinkingBudget: budget };
}

export interface TokenUsage {
  /** Prompt tokens billed at the input rate (cached tokens excluded). */
  inputTokens: number;
  /** Visible response tokens. */
  outputTokens: number;
  /** Thinking tokens. Billed at the output rate, not reported inside it. */
  reasoningTokens?: number;
  /** Prompt tokens served from cache, billed at the cached-input rate. */
  cachedInputTokens?: number;
  /** Tool-result tokens fed back to the model; billed at the input rate. */
  toolUseInputTokens?: number;
}

export interface CostBreakdown {
  input: number;
  output: number;
  reasoning: number;
  cachedInput: number;
  toolUseInput: number;
  total: number;
}

/** The rate card in force at `at`, or `null` for a call before any card starts. */
export function rateCardAt(model: ModelId, at: Date): RateCard | null {
  const cards = MODELS[model].rates as readonly RateCard[];
  let chosen: RateCard | null = null;
  for (const card of cards) {
    if (Date.parse(card.effectiveFrom) <= at.getTime()) chosen = card;
  }
  return chosen;
}

/**
 * Cost of one call in USD. Returns `null` for a model we have no price for, so
 * an unpriced model shows up as a missing number rather than as a confident $0.
 */
export function costUsd(
  model: string,
  usage: TokenUsage,
  at: Date = new Date(),
): CostBreakdown | null {
  if (!isKnownModel(model)) return null;
  const card = rateCardAt(model, at);
  if (!card) return null;

  const cachedInputTokens = usage.cachedInputTokens ?? 0;
  const reasoningTokens = usage.reasoningTokens ?? 0;
  const toolUseInputTokens = usage.toolUseInputTokens ?? 0;

  // The tier is chosen by the size of the whole prompt, cached part included —
  // that is what Google meters, and splitting it would price a long cached
  // prompt as if it were short.
  const promptTokens = usage.inputTokens + cachedInputTokens;
  const threshold = (MODELS[model] as ModelPricing).longContextThresholdTokens;
  const rates = threshold && promptTokens > threshold && card.long ? card.long : card;

  const perToken = (perMTok: number) => perMTok / 1_000_000;
  const input = usage.inputTokens * perToken(rates.inputPerMTok);
  const output = usage.outputTokens * perToken(rates.outputPerMTok);
  const reasoning = reasoningTokens * perToken(rates.outputPerMTok);
  const cachedInput = cachedInputTokens * perToken(rates.cachedInputPerMTok);
  const toolUseInput = toolUseInputTokens * perToken(rates.inputPerMTok);

  return {
    input,
    output,
    reasoning,
    cachedInput,
    toolUseInput,
    total: input + output + reasoning + cachedInput + toolUseInput,
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
  if (usage.reasoningTokens) details.output_reasoning = usage.reasoningTokens;
  if (usage.cachedInputTokens) details.cache_read_input = usage.cachedInputTokens;
  if (usage.toolUseInputTokens) details.tool_use_input = usage.toolUseInputTokens;
  details.total = Object.values(details).reduce((sum, value) => sum + value, 0);
  return details;
}

/** Langfuse `costDetails`, in USD, matching the `usageDetails` keys. */
export function costDetails(breakdown: CostBreakdown): Record<string, number> {
  return {
    input: breakdown.input,
    output: breakdown.output,
    output_reasoning: breakdown.reasoning,
    cache_read_input: breakdown.cachedInput,
    tool_use_input: breakdown.toolUseInput,
    total: breakdown.total,
  };
}
