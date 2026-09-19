import { describe, expect, it } from "vitest";

import {
  costDetails,
  costUsd,
  thinkingSettings,
  usageDetails,
} from "@/lib/ai/models";

const NOW = new Date("2026-09-18T00:00:00Z");

describe("costUsd", () => {
  it("prices input and output separately", () => {
    // gemini-3.8-flash: $0.75/1M in, $3.75/1M out (2026 rate).
    const cost = costUsd(
      "gemini-3.8-flash",
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      NOW,
    );
    expect(cost?.input).toBeCloseTo(0.75, 10);
    expect(cost?.output).toBeCloseTo(3.75, 10);
    expect(cost?.total).toBeCloseTo(4.5, 10);
  });

  it("bills thinking tokens at the output rate", () => {
    // The whole reason `reasoningTokens` exists: Gemini reports thinking
    // outside `candidatesTokenCount`, and it is the larger half of the bill on
    // a reasoning-heavy grading call.
    const cost = costUsd(
      "gemini-3.8-flash",
      { inputTokens: 0, outputTokens: 0, reasoningTokens: 1_000_000 },
      NOW,
    );
    expect(cost?.reasoning).toBeCloseTo(3.75, 10);
    expect(cost?.total).toBeCloseTo(3.75, 10);
  });

  it("prices cached prompt tokens at the cache rate, not the input rate", () => {
    const cost = costUsd(
      "gemini-3.8-flash",
      { inputTokens: 0, outputTokens: 0, cachedInputTokens: 1_000_000 },
      NOW,
    );
    expect(cost?.cachedInput).toBeCloseTo(0.075, 10);
  });

  it("applies the long-context tier above the model's threshold", () => {
    const short = costUsd(
      "gemini-2.5-pro",
      { inputTokens: 200_000, outputTokens: 1000 },
      NOW,
    )!;
    const long = costUsd(
      "gemini-2.5-pro",
      { inputTokens: 200_001, outputTokens: 1000 },
      NOW,
    )!;

    // One token over the line doubles the input rate and raises the output
    // rate; a cost chart that ignored the tier would under-report by ~40%.
    expect(short.input).toBeCloseTo((200_000 * 1.25) / 1e6, 12);
    expect(long.input).toBeCloseTo((200_001 * 2.5) / 1e6, 12);
    expect(long.output).toBeCloseTo((1000 * 15) / 1e6, 12);
  });

  it("counts the cached part of the prompt when choosing the tier", () => {
    // Google meters the whole prompt. Pricing only the uncached slice would put
    // a 300k-token cached prompt on the short-context rate.
    const cost = costUsd(
      "gemini-2.5-pro",
      { inputTokens: 100_000, outputTokens: 0, cachedInputTokens: 150_000 },
      NOW,
    )!;
    expect(cost.input).toBeCloseTo((100_000 * 2.5) / 1e6, 12);
    expect(cost.cachedInput).toBeCloseTo((150_000 * 0.25) / 1e6, 12);
  });

  it("uses the rate card in force on the day of the call", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 0 };
    const before = costUsd("gemini-3.8-flash", usage, new Date("2026-12-31T23:59:59Z"));
    const after = costUsd("gemini-3.8-flash", usage, new Date("2027-01-01T00:00:00Z"));

    // Google's published increase. A December call must keep costing what we
    // paid in December, or the year-end cost chart rewrites its own history.
    expect(before?.input).toBeCloseTo(0.75, 10);
    expect(after?.input).toBeCloseTo(1.5, 10);
  });

  it("returns a realistic per-item figure rather than rounding to zero", () => {
    // A short-answer grading call: ~900 in, ~350 out on the default model.
    const cost = costUsd("gemini-3.8-flash", { inputTokens: 900, outputTokens: 350 }, NOW);
    expect(cost?.total).toBeCloseTo((900 * 0.75) / 1e6 + (350 * 3.75) / 1e6, 12);
  });

  it("returns null for an unpriced model instead of a confident zero", () => {
    // A missing price must surface as a gap in the cost dashboard. Reporting $0
    // would quietly under-report spend, which is the worst possible failure for
    // a number the team makes model decisions on.
    expect(costUsd("some-model-we-never-priced", { inputTokens: 100, outputTokens: 100 })).toBeNull();
  });
});

describe("thinkingSettings", () => {
  it("sends a thinking level to the models that take one", () => {
    expect(thinkingSettings("gemini-3.8-flash", "high")).toEqual({ thinkingLevel: "HIGH" });
  });

  it("sends a token budget to the 2.5 family", () => {
    expect(thinkingSettings("gemini-2.5-flash-lite", "minimal")).toEqual({ thinkingBudget: 0 });
    expect(thinkingSettings("gemini-2.5-flash-lite", "medium")).toEqual({ thinkingBudget: 8192 });
  });

  it("clamps to the model's minimum instead of sending a rejected budget", () => {
    // gemini-2.5-pro cannot turn thinking off. Passing 0 is a 400 in the middle
    // of grading a child's work, which is not where we want to discover it.
    expect(thinkingSettings("gemini-2.5-pro", "minimal")).toEqual({ thinkingBudget: 128 });
  });

  it("leaves the model default alone when a prompt declares no effort", () => {
    // Not the same as `minimal`: silently forcing a level would change the
    // behaviour of every prompt version that never asked for one.
    expect(thinkingSettings("gemini-3.8-flash", undefined)).toBeNull();
  });
});

describe("usageDetails", () => {
  it("sums total across every non-total key", () => {
    const details = usageDetails({
      inputTokens: 10,
      outputTokens: 20,
      reasoningTokens: 7,
      cachedInputTokens: 5,
      toolUseInputTokens: 3,
    });
    expect(details).toEqual({
      input: 10,
      output: 20,
      output_reasoning: 7,
      cache_read_input: 5,
      tool_use_input: 3,
      total: 45,
    });
  });

  it("omits the optional keys when nothing was cached or thought", () => {
    expect(usageDetails({ inputTokens: 10, outputTokens: 20 })).toEqual({
      input: 10,
      output: 20,
      total: 30,
    });
  });
});

describe("costDetails", () => {
  it("keeps the total consistent with the breakdown Langfuse charts", () => {
    const cost = costUsd(
      "gemini-3.8-flash",
      { inputTokens: 1000, outputTokens: 500, reasoningTokens: 250, cachedInputTokens: 100 },
      NOW,
    )!;
    const details = costDetails(cost);
    expect(details.total).toBeCloseTo(
      details.input +
        details.output +
        details.output_reasoning +
        details.cache_read_input +
        details.tool_use_input,
      12,
    );
  });
});
