import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { startFakeIngestion, type FakeIngestion } from "@/lib/observability/fake-ingestion-server";

/**
 * What actually goes on the wire.
 *
 * These tests intercept the Langfuse ingestion endpoint and assert on the bytes
 * the SDK sends, because that is the only question that matters for a product
 * used by children: not "did we call redactDeep", but "what left the process".
 */

/**
 * This file asks what a trace looks like on the wire, not whether it is allowed
 * out — that gate has its own file. The leaked-credential check (PRO-101) is
 * stubbed clean here so it does not quietly rewrite every payload assertion
 * below into "nothing was sent", which is a passing-looking way to test nothing.
 */
vi.mock("@/lib/observability/leaked-credentials", () => {
  const clean = (id: string) => async () => ({
    id,
    ok: true,
    severity: "blocker" as const,
    reason: "stubbed clean",
    remedy: "None needed.",
  });
  return {
    checkCredentialsInUse: clean("leaked_credentials_in_use"),
    checkLeakedCredentialsRevoked: clean("leaked_credentials_live"),
  };
});

let ingestion: FakeIngestion;
let traceAiCall: typeof import("@/lib/observability/langfuse").traceAiCall;
let TraceIdentityError: typeof import("@/lib/observability/langfuse").TraceIdentityError;

beforeAll(async () => {
  ingestion = await startFakeIngestion();

  vi.stubEnv("APP_ENV", "production");
  vi.stubEnv("LANGFUSE_PUBLIC_KEY", "pk-lf-test");
  vi.stubEnv("LANGFUSE_SECRET_KEY", "sk-lf-test");
  vi.stubEnv("LANGFUSE_BASEURL", ingestion.baseUrl);

  // env.ts reads process.env at module load, so the stubs must be in place
  // before the module graph is built.
  vi.resetModules();
  ({ traceAiCall, TraceIdentityError } = await import("@/lib/observability/langfuse"));
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

/**
 * The trace body that carries the caller's metadata.
 *
 * `traceAiCall` emits a create and then an update, both as trace events, and a
 * batch is not ordered — the update (which carries only `durationMs`/`usage`)
 * can arrive first. Look the create up by the `name` only it sets rather than
 * trusting position.
 */
function traceCreateBody() {
  const event = traceEvents().find(
    (candidate) => (candidate.body as { name?: string }).name !== undefined,
  );
  return event!.body as {
    id?: string;
    sessionId?: string;
    metadata?: Record<string, unknown>;
  };
}

/** A client-minted uuidv7, of the shape `events.behavior_event.correlation_id` holds. */
const CORRELATION_ID = "0199a3f1-8c42-7c19-9b7e-4a1f2d3e5c60";
const SESSION_ID = "0199a3f1-7b10-7aa4-8f31-9c2b6d4e1a07";

describe("traceAiCall wire payload", () => {
  it("sends a trace with the pseudonymous learner ref as userId", async () => {
    await traceAiCall(
      { name: "grade.short-answer", learnerRef: "learner_7f3a91", correlationId: CORRELATION_ID },
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

  it("carries the four fields data-schema §5 makes mandatory", async () => {
    // These were missing from the allow-list until PRO-15, which meant a caller
    // could set every one of them correctly and have all four dropped on the
    // way out — a trace that looks complete and does not carry what the spec
    // requires. `consentScopes` is the one that matters most: without it there
    // is no way to tell, after the fact, whether a call was allowed to happen.
    await traceAiCall(
      {
        name: "grade.short-answer",
        metadata: {
          rubricVersion: "SCI.EXPLAIN@3",
          redactionVersion: "redact-v2",
          consentScopes: ["service_operation", "ai_grading"],
          gradeBand: "p5",
        },
      },
      async () => ({ output: "ok" }),
    );

    const metadata = traceCreateBody().metadata;
    expect(metadata).toMatchObject({
      rubricVersion: "SCI.EXPLAIN@3",
      redactionVersion: "redact-v2",
      gradeBand: "p5",
    });
    // A list, not a joined string — a consent filter over "ai_grading,other"
    // would match nothing.
    expect(metadata?.consentScopes).toEqual(["service_operation", "ai_grading"]);
  });

  it("warns about a dropped key instead of dropping it in silence", async () => {
    // The original complaint in PRO-15: an unknown key vanished with no signal
    // at all, so a trace missing a mandatory field looked exactly like a healthy
    // one. Deployed environments warn rather than throw — a metadata typo must
    // never fail a child's grading mid-request.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await traceAiCall(
      {
        name: "grade.short-answer",
        metadata: { rubric_version: "SCI.EXPLAIN@3" } as Record<string, unknown>,
      },
      async () => ({ output: "ok" }),
    );

    // snake_case is the database's convention, not this surface's, so the
    // spec-shaped key is exactly the mistake someone will make first.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("rubric_version"));
    warn.mockRestore();
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

/**
 * `data-schema` §5, the two rows PRO-15 did not close.
 *
 * The question these answer is not "did we set a field" but "is the id on the
 * wire the one the client minted", because everything downstream — the
 * `ai_verdict` CHECK, the behaviour join, the session view — is an equality
 * between two values that were produced in different processes.
 */
describe("trace identity on the wire", () => {
  it("uses the caller's correlation id as the trace id, not one Langfuse invented", async () => {
    const seen: (string | null)[] = [];

    await traceAiCall(
      {
        name: "grade.short-answer",
        learnerRef: "learner_7f3a91",
        correlationId: CORRELATION_ID,
        sessionId: SESSION_ID,
      },
      async (ctx) => {
        seen.push(ctx.traceId);
        return { output: "ok" };
      },
    );

    const body = traceCreateBody();
    expect(body.id).toBe(CORRELATION_ID);
    expect(body.sessionId).toBe(SESSION_ID);
    // The same value the caller will write to app.ai_verdict.langfuse_trace_id,
    // where a CHECK insists it equals correlation_id.
    expect(seen).toEqual([CORRELATION_ID]);
  });

  it("keeps every trace event of the call under that one id", async () => {
    // The create and the update are separate ingestion events. If only the
    // create carried our id, the update would land on a trace that does not
    // exist and the duration/usage would be lost.
    await traceAiCall(
      { name: "grade.short-answer", correlationId: CORRELATION_ID },
      async () => ({ output: "ok", usage: { total: 12 } }),
    );

    const ids = traceEvents().map((event) => (event.body as { id?: string }).id);
    expect(ids.length).toBeGreaterThan(1);
    expect(new Set(ids)).toEqual(new Set([CORRELATION_ID]));
  });

  it("still works without an id for a call that belongs to no child", async () => {
    // Dataset runs and evals have nothing to join back to. They keep the old
    // behaviour: Langfuse mints the id.
    await traceAiCall({ name: "eval.rubric-agreement" }, async () => ({ output: "ok" }));

    expect(traceCreateBody().id).toBeTruthy();
    expect(traceCreateBody().id).not.toBe(CORRELATION_ID);
  });

  it("refuses a learner-bound call that carries no correlation id", async () => {
    let called = false;

    await expect(
      traceAiCall({ name: "grade.short-answer", learnerRef: "learner_7f3a91" }, async () => {
        called = true;
        return { output: "ok" };
      }),
    ).rejects.toThrow(TraceIdentityError);

    // Refused before the model call: no tokens spent, and no half-finished
    // grading to explain to anyone.
    expect(called).toBe(false);
    expect(traceEvents()).toHaveLength(0);
  });

  it("refuses an id that is not a canonical uuid instead of shipping it", async () => {
    // The failure this prevents is silent: Langfuse accepts any string as a
    // trace id, so `trace_2024` would produce a perfectly healthy-looking trace
    // that no `uuid` column can ever point at.
    await expect(
      traceAiCall({ name: "grade.short-answer", correlationId: "trace_2024" }, async () => ({
        output: "ok",
      })),
    ).rejects.toThrow(/correlationId/);

    // Same value, wrong case. Postgres would store it lowercased, so the trace
    // URL and the stored id would differ by exactly the bug nobody looks for.
    await expect(
      traceAiCall(
        { name: "grade.short-answer", correlationId: CORRELATION_ID.toUpperCase() },
        async () => ({ output: "ok" }),
      ),
    ).rejects.toThrow(/correlationId/);

    await expect(
      traceAiCall(
        { name: "grade.short-answer", correlationId: CORRELATION_ID, sessionId: "session-42" },
        async () => ({ output: "ok" }),
      ),
    ).rejects.toThrow(/sessionId/);

    expect(traceEvents()).toHaveLength(0);
  });
});

describe("allow-list enforcement on a developer machine", () => {
  it("throws on an unknown metadata key so the mistake surfaces while it is cheap", async () => {
    // Deployed environments warn; locally this is an error, because the moment
    // worth catching a dropped mandatory field is while someone is still
    // writing the call — not months later when a dashboard is empty and nobody
    // can say when it stopped filling.
    vi.stubEnv("APP_ENV", "local");
    vi.resetModules();
    const local = await import("@/lib/observability/langfuse");

    expect(() =>
      local.allowedTraceMetadata({ grade_band: "p5" } as Record<string, unknown>),
    ).toThrow(/grade_band/);

    // The allowed spelling of the same fact goes through untouched.
    expect(local.allowedTraceMetadata({ gradeBand: "p5" })).toEqual({ gradeBand: "p5" });

    vi.stubEnv("APP_ENV", "production");
    vi.resetModules();
  });
});
