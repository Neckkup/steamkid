import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { startFakeIngestion, type FakeIngestion } from "@/lib/observability/fake-ingestion-server";

/**
 * What actually goes on the wire.
 *
 * These tests intercept the Langfuse ingestion endpoint and assert on the bytes
 * the SDK sends, because that is the only question that matters for a product
 * used by children: not "did we call redactDeep", but "what left the process".
 */

let ingestion: FakeIngestion;
let traceAiCall: typeof import("@/lib/observability/langfuse").traceAiCall;

beforeAll(async () => {
  ingestion = await startFakeIngestion();

  vi.stubEnv("APP_ENV", "production");
  vi.stubEnv("LANGFUSE_PUBLIC_KEY", "pk-lf-test");
  vi.stubEnv("LANGFUSE_SECRET_KEY", "sk-lf-test");
  vi.stubEnv("LANGFUSE_BASEURL", ingestion.baseUrl);

  // env.ts reads process.env at module load, so the stubs must be in place
  // before the module graph is built.
  vi.resetModules();
  ({ traceAiCall } = await import("@/lib/observability/langfuse"));
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await ingestion.close();
});

beforeEach(() => ingestion.reset());

function traceEvents() {
  return ingestion.events.filter((event) => event.type.startsWith("trace"));
}

function allBytes() {
  return ingestion.rawBodies.join("\n");
}

describe("traceAiCall wire payload", () => {
  it("sends a trace with the pseudonymous learner ref as userId", async () => {
    await traceAiCall(
      { name: "grade.short-answer", learnerRef: "learner_7f3a91" },
      async () => ({ output: { score: 3 } }),
    );

    const body = traceEvents()[0].body as { userId?: string; name?: string };
    expect(body.name).toBe("grade.short-answer");
    expect(body.userId).toBe("learner_7f3a91");
  });

  it("tags every trace with the Langfuse environment so prod charts stay clean", async () => {
    await traceAiCall({ name: "grade.short-answer" }, async () => ({ output: "ok" }));

    // APP_ENV=production is stubbed above.
    const body = traceEvents()[0].body as { environment?: string };
    expect(body.environment).toBe("production");
  });

  it("drops metadata that is not on the allow-list", async () => {
    await traceAiCall(
      {
        name: "grade.short-answer",
        metadata: {
          lessonId: "lesson_42",
          // Not on ALLOWED_TRACE_METADATA_KEYS. A future contributor adding a
          // field must add it deliberately; until then it is invisible.
          childFullName: "Nong Kong",
          schoolName: "Wat Bowon School",
        } as Record<string, unknown>,
      },
      async () => ({ output: "ok" }),
    );

    const metadata = (traceEvents()[0].body as { metadata?: Record<string, unknown> }).metadata;
    expect(metadata).toMatchObject({ lessonId: "lesson_42" });
    expect(metadata).not.toHaveProperty("childFullName");
    expect(metadata).not.toHaveProperty("schoolName");
    expect(allBytes()).not.toContain("Wat Bowon School");
  });

  it("redacts denied keys anywhere in the input, at any depth", async () => {
    await traceAiCall(
      {
        name: "grade.short-answer",
        input: {
          submissionId: "sub_1",
          learner: {
            email: "kong@example.com",
            firstName: "Kong",
            guardian: { phone: "081-234-5678" },
          },
        },
      },
      async () => ({ output: "ok" }),
    );

    const bytes = allBytes();
    expect(bytes).not.toContain("kong@example.com");
    expect(bytes).not.toContain("081-234-5678");
    expect(bytes).not.toContain("Kong");
    expect(bytes).toContain("[REDACTED]");
    // The non-identifying reference is preserved — redaction must not destroy
    // the ability to find the submission again in our own database.
    expect(bytes).toContain("sub_1");
  });

  it("scrubs identifier-shaped strings hiding inside allowed free text", async () => {
    await traceAiCall(
      {
        name: "grade.short-answer",
        input: { note: "contact me at kong@example.com or 0812345678, id 1234567890123" },
      },
      async () => ({ output: "ok" }),
    );

    const bytes = allBytes();
    expect(bytes).not.toContain("kong@example.com");
    expect(bytes).not.toContain("0812345678");
    expect(bytes).not.toContain("1234567890123");
  });

  it("redacts the model output as well as the input", async () => {
    await traceAiCall({ name: "grade.short-answer" }, async () => ({
      output: { feedback: "Great work! Tell your mum at mum@example.com." },
    }));

    expect(allBytes()).not.toContain("mum@example.com");
  });

  it("records a failure as a tagged trace with a redacted error, and rethrows", async () => {
    await expect(
      traceAiCall({ name: "grade.short-answer", tags: ["grading"] }, async () => {
        throw new Error("upstream rejected kong@example.com");
      }),
    ).rejects.toThrow("upstream rejected");

    const bytes = allBytes();
    expect(bytes).toContain("error");
    expect(bytes).not.toContain("kong@example.com");

    const updates = traceEvents().map((event) => event.body as { tags?: string[] });
    expect(updates.some((body) => body.tags?.includes("error"))).toBe(true);
  });

  it("flushes before returning, so a serverless freeze cannot lose the trace", async () => {
    await traceAiCall({ name: "grade.short-answer" }, async () => ({ output: "ok" }));
    // No waiting, no timers: the events are already on the wire when the call
    // resolves. This is the property that makes "every AI call is traced" true
    // on Vercel rather than true in principle.
    expect(traceEvents().length).toBeGreaterThan(0);
  });
});
