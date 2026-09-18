import { describe, expect, it } from "vitest";

import { costDetails, costUsd, usageDetails } from "@/lib/ai/models";

describe("costUsd", () => {
  it("prices input and output separately", () => {
    // claude-opus-5: $5/1M in, $25/1M out.
    const cost = costUsd("claude-opus-5", { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(cost?.input).toBeCloseTo(5, 10);
    expect(cost?.output).toBeCloseTo(25, 10);
    expect(cost?.total).toBeCloseTo(30, 10);
  });

  it("prices cache writes at 1.25x and cache reads at 0.1x the input rate", () => {
    const cost = costUsd("claude-opus-5", {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
    });
    expect(cost?.cacheWrite).toBeCloseTo(6.25, 10);
    expect(cost?.cacheRead).toBeCloseTo(0.5, 10);
    expect(cost?.total).toBeCloseTo(6.75, 10);
  });

  it("returns a realistic per-item figure rather than rounding to zero", () => {
    // A short-answer grading call: ~900 in, ~350 out on Haiku 4.5.
    const cost = costUsd("claude-haiku-4-5", { inputTokens: 900, outputTokens: 350 });
    expect(cost?.total).toBeCloseTo(0.0009 + 0.00175, 10);
  });

  it("returns null for an unpriced model instead of a confident zero", () => {
    // A missing price must surface as a gap in the cost dashboard. Reporting $0
    // would quietly under-report spend, which is the worst possible failure for
    // a number the team makes model decisions on.
    expect(costUsd("some-model-we-never-priced", { inputTokens: 100, outputTokens: 100 })).toBeNull();
  });
});

describe("usageDetails", () => {
  it("sums total across every non-total key", () => {
    const details = usageDetails({
      inputTokens: 10,
      outputTokens: 20,
      cacheCreationTokens: 5,
      cacheReadTokens: 3,
    });
    expect(details).toEqual({
      input: 10,
      output: 20,
      cache_creation_input: 5,
      cache_read_input: 3,
      total: 38,
    });
  });

  it("omits cache keys when nothing was cached", () => {
    expect(usageDetails({ inputTokens: 10, outputTokens: 20 })).toEqual({
      input: 10,
      output: 20,
      total: 30,
    });
  });
});

describe("costDetails", () => {
  it("keeps the total consistent with the breakdown Langfuse charts", () => {
    const cost = costUsd("claude-sonnet-5", { inputTokens: 1000, outputTokens: 500 })!;
    const details = costDetails(cost);
    expect(details.total).toBeCloseTo(
      details.input + details.output + details.cache_creation_input + details.cache_read_input,
      12,
    );
  });
});
