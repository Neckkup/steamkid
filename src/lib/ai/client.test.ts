import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { startFakeIngestion, type FakeIngestion } from "@/lib/observability/fake-ingestion-server";

/**
 * The central helper's privacy contract.
 *
 * The single most important property of `callModel`: the model sees the child's
 * answer, and the trace does not — unless a caller explicitly decides otherwise
 * for content the privacy policy allows. A trace is a long-lived, widely-read
 * artefact; a child's free text ends up in it only on purpose, never by
 * forgetting to think about it.
 */

const LEARNER_TEXT =
  "Photosynthesis is how plants eat. My name is Nong Kong and I go to Wat Bowon School.";

const requests: Record<string, unknown>[] = [];

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = {
      create: async (request: Record<string, unknown>) => {
        requests.push(request);
        return {
          content: [{ type: "text", text: '{"ok":true,"wordCount":15,"language":"en"}' }],
          usage: {
            input_tokens: 412,
            output_tokens: 24,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          stop_reason: "end_turn",
        };
      },
    };
  }
  return { default: FakeAnthropic };
});

let ingestion: FakeIngestion;
let callModel: typeof import("@/lib/ai/client").callModel;

beforeAll(async () => {
  ingestion = await startFakeIngestion();

  vi.stubEnv("APP_ENV", "preview");
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
  vi.stubEnv("LANGFUSE_PUBLIC_KEY", "pk-lf-test");
  vi.stubEnv("LANGFUSE_SECRET_KEY", "sk-lf-test");
  vi.stubEnv("LANGFUSE_BASEURL", ingestion.baseUrl);

  vi.resetModules();
  ({ callModel } = await import("@/lib/ai/client"));
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await ingestion.close();
});

beforeEach(() => {
  ingestion.reset();
  requests.length = 0;
});

async function runSmokePrompt(overrides: Record<string, unknown> = {}) {
  return callModel({
    promptName: "ops/observability-smoke",
    learnerRef: "learner_7f3a91",
    variables: { learnerText: LEARNER_TEXT },
    ...overrides,
  });
}

describe("callModel", () => {
  it("sends the child's text to the model but not to the trace", async () => {
    await runSmokePrompt();

    // The model was given the real answer — grading has to see it.
    expect(JSON.stringify(requests[0])).toContain("Nong Kong");

    // The trace got a pointer instead.
    const bytes = ingestion.rawBodies.join("\n");
    expect(bytes).not.toContain("Nong Kong");
    expect(bytes).not.toContain("Wat Bowon School");
    expect(bytes).toContain("content withheld; stored in steamkid database");
  });

  it("puts model, prompt version, tokens and USD cost on the generation", async () => {
    const result = await runSmokePrompt();

    // The SDK ships the generation as a create plus an update, and a batch is
    // not ordered — look each one up by type rather than by position.
    const created = ingestion.events.find((event) => event.type === "generation-create")!
      .body as { model?: string; modelParameters?: Record<string, unknown> };
    const updated = ingestion.events.find((event) => event.type === "generation-update")!
      .body as { usageDetails?: Record<string, number>; costDetails?: Record<string, number> };

    expect(created.model).toBe("claude-haiku-4-5");
    expect(created.modelParameters).toMatchObject({ maxTokens: 256 });
    expect(updated.usageDetails).toMatchObject({ input: 412, output: 24, total: 436 });
    // claude-haiku-4-5: $1/1M in, $5/1M out.
    expect(updated.costDetails?.total).toBeCloseTo(412 / 1e6 + (24 * 5) / 1e6, 12);
    expect(result.cost?.total).toBeCloseTo(updated.costDetails!.total, 12);
  });

  it("repeats the allow-listed metadata on the generation so dashboards can filter", async () => {
    await runSmokePrompt();

    // Cost/latency/error widgets query the observations view, which cannot read
    // a parent trace's metadata. If this regresses, every dashboard filtered on
    // `feature` or `promptSource` silently renders empty.
    const created = ingestion.events.find((event) => event.type === "generation-create")!.body as {
      metadata?: Record<string, unknown>;
    };

    expect(created.metadata).toMatchObject({
      feature: "ops",
      promptName: "ops/observability-smoke",
      promptSource: "fallback",
      promptLabel: "production",
      model: "claude-haiku-4-5",
    });
  });

  it("measures latency and returns an openable trace link", async () => {
    const result = await runSmokePrompt();

    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.traceId).toBeTruthy();
    expect(result.traceUrl).toBe(`${ingestion.baseUrl}/trace/${result.traceId}`);
  });

  it("marks the run as fallback-served when Langfuse has no such prompt", async () => {
    const result = await runSmokePrompt();

    // The fake instance serves no prompts, so the in-repo copy ran. Dashboards
    // and dataset runs must be able to exclude these — they cannot be
    // attributed to a prompt version.
    expect(result.promptSource).toBe("fallback");
    expect(result.promptVersion).toBe(0);
  });

  it("parses structured output when a schema is supplied", async () => {
    const result = await runSmokePrompt({
      outputSchema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
    });

    expect(result.json).toEqual({ ok: true, wordCount: 15, language: "en" });
    expect((requests[0].output_config as { format?: { type?: string } })?.format?.type).toBe(
      "json_schema",
    );
  });

  it("lets a caller opt in to recording content on the trace", async () => {
    await runSmokePrompt({ traceInput: { rubricId: "rubric_photosynthesis_v1" } });

    expect(ingestion.rawBodies.join("\n")).toContain("rubric_photosynthesis_v1");
  });

  it("refuses an unregistered prompt rather than inventing one", async () => {
    await expect(callModel({ promptName: "grading/not-registered" })).rejects.toThrow(
      /Unknown prompt/,
    );
  });
});
