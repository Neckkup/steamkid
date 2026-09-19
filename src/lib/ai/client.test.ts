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

/** Overridable per test, so a safety block or a thinking-heavy call is testable. */
let nextResponse: () => Record<string, unknown>;

function okResponse(): Record<string, unknown> {
  return {
    text: '{"ok":true,"wordCount":15,"language":"en"}',
    candidates: [{ finishReason: "STOP" }],
    usageMetadata: {
      // Gemini reports the cached slice *inside* promptTokenCount.
      promptTokenCount: 412,
      candidatesTokenCount: 24,
      thoughtsTokenCount: 0,
      totalTokenCount: 436,
    },
  };
}

// Only the transport is faked. The rest of the module — notably the real
// `ThinkingLevel` enum that `models.ts` maps effort onto — is kept, so a test
// asserting a thinking setting is asserting the value that would go on the
// wire, not a value this file invented.
vi.mock("@google/genai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@google/genai")>();
  class FakeGoogleGenAI {
    models = {
      generateContent: async (request: Record<string, unknown>) => {
        requests.push(request);
        return nextResponse();
      },
    };
  }
  return { ...actual, GoogleGenAI: FakeGoogleGenAI };
});

let ingestion: FakeIngestion;
let callModel: typeof import("@/lib/ai/client").callModel;
let ModelSafetyBlockError: typeof import("@/lib/ai/client").ModelSafetyBlockError;

beforeAll(async () => {
  ingestion = await startFakeIngestion();

  vi.stubEnv("APP_ENV", "preview");
  vi.stubEnv("GEMINI_API_KEY", "test-gemini-key");
  vi.stubEnv("LANGFUSE_PUBLIC_KEY", "pk-lf-test");
  vi.stubEnv("LANGFUSE_SECRET_KEY", "sk-lf-test");
  vi.stubEnv("LANGFUSE_BASEURL", ingestion.baseUrl);

  vi.resetModules();
  ({ callModel, ModelSafetyBlockError } = await import("@/lib/ai/client"));
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await ingestion.close();
});

beforeEach(() => {
  ingestion.reset();
  requests.length = 0;
  nextResponse = okResponse;
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

    expect(created.model).toBe("gemini-2.5-flash-lite");
    expect(created.modelParameters).toMatchObject({ maxTokens: 256 });
    expect(updated.usageDetails).toMatchObject({ input: 412, output: 24, total: 436 });
    // gemini-2.5-flash-lite: $0.10/1M in, $0.40/1M out.
    expect(updated.costDetails?.total).toBeCloseTo((412 * 0.1) / 1e6 + (24 * 0.4) / 1e6, 12);
    expect(result.cost?.total).toBeCloseTo(updated.costDetails!.total, 12);
  });

  it("bills thinking tokens and excludes cached tokens from the input rate", async () => {
    nextResponse = () => ({
      ...okResponse(),
      usageMetadata: {
        promptTokenCount: 1000, // 400 of these came from cache
        cachedContentTokenCount: 400,
        candidatesTokenCount: 100,
        thoughtsTokenCount: 900,
        totalTokenCount: 2000,
      },
    });

    const result = await runSmokePrompt();

    // Reading `promptTokenCount` as billable input would charge the cached 400
    // twice, and dropping `thoughtsTokenCount` would hide 900 output-rate
    // tokens — nine times the visible answer on this call.
    expect(result.usage).toMatchObject({
      inputTokens: 600,
      outputTokens: 100,
      reasoningTokens: 900,
      cachedInputTokens: 400,
    });
    expect(result.cost?.total).toBeCloseTo(
      (600 * 0.1) / 1e6 + (100 * 0.4) / 1e6 + (900 * 0.4) / 1e6 + (400 * 0.01) / 1e6,
      12,
    );

    const updated = ingestion.events.find((event) => event.type === "generation-update")!
      .body as { usageDetails?: Record<string, number> };
    expect(updated.usageDetails).toMatchObject({
      input: 600,
      output: 100,
      output_reasoning: 900,
      cache_read_input: 400,
      total: 2000,
    });
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
      model: "gemini-2.5-flash-lite",
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
    const config = requests[0].config as Record<string, unknown>;
    expect(config.responseMimeType).toBe("application/json");
    expect(config.responseJsonSchema).toMatchObject({ type: "object" });
  });

  it("hoists the system prompt and never asks for an at-rest context cache", async () => {
    await runSmokePrompt();

    const config = requests[0].config as Record<string, unknown>;
    expect(String(config.systemInstruction)).toContain("health check");
    // Explicit caching would store a child's prompt on Google's side; ADR 0004
    // depends on that never being sent.
    expect(config).not.toHaveProperty("cachedContent");
    expect(requests[0].contents).toEqual([
      { role: "user", parts: [{ text: expect.stringContaining("<learner_text>") }] },
    ]);
  });

  it("translates the prompt's effort into this model's thinking control", async () => {
    await runSmokePrompt();

    // The canary runs on a 2.5 model, which takes a token budget rather than a
    // thinking level. Sending the wrong one is a 400 mid-grade.
    expect((requests[0].config as Record<string, unknown>).thinkingConfig).toEqual({
      thinkingBudget: 0,
    });
  });

  it("raises a safety block instead of returning an empty answer", async () => {
    nextResponse = () => ({
      text: "",
      candidates: [{ finishReason: "SAFETY" }],
      usageMetadata: { promptTokenCount: 412, candidatesTokenCount: 0, totalTokenCount: 412 },
    });

    // A blocked response returning "" would be graded as a wrong answer by a
    // caller that does not check, which is the worst possible silent failure on
    // a child's work.
    await expect(runSmokePrompt()).rejects.toBeInstanceOf(ModelSafetyBlockError);

    // Exactly one terminal update, and it is the error one. Emitting a
    // success-shaped update first and correcting it afterwards would leave the
    // right final state only because Langfuse merges observations by id.
    const updates = ingestion.events.filter((event) => event.type === "generation-update");
    expect(updates).toHaveLength(1);

    const updated = updates[0].body as {
      level?: string;
      statusMessage?: string;
      usageDetails?: Record<string, number>;
      costDetails?: Record<string, number>;
    };
    expect(updated.level).toBe("ERROR");
    expect(updated.statusMessage).toBe("ModelSafetyBlockError");
    // A blocked grade still burned tokens and still cost money. Dropping them
    // would under-report spend on precisely the prompts that need fixing.
    expect(updated.usageDetails).toMatchObject({ input: 412, output: 0 });
    expect(updated.costDetails?.total).toBeCloseTo((412 * 0.1) / 1e6, 12);
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
