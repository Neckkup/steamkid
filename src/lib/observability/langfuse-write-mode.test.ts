import { describe, expect, it, vi } from "vitest";

import { checkLangfuseWriteMode } from "./langfuse-write-mode";

const CREDENTIALS = {
  baseUrl: "https://langfuse.example.invalid",
  publicKey: "pk-lf-test",
  secretKey: "sk-lf-test",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Never wait in a test; the read-back poll is bounded, not timed, here. */
const NO_WAIT = { readBackAttempts: 3, readBackDelayMs: 0 } as const;

/**
 * Split the two calls the probe makes, so a test can say "ingestion accepted
 * but the trace never appeared" — the case the read-back exists to catch.
 */
function router(handlers: {
  ingestion: (init?: RequestInit) => Response;
  readBack?: () => Response;
}) {
  return vi.fn(async (url: unknown, init?: RequestInit) => {
    if (String(url).includes("/api/public/ingestion")) return handlers.ingestion(init);
    return handlers.readBack?.() ?? jsonResponse(404, { message: "not found" });
  });
}

const ACCEPTED = (init?: RequestInit) => {
  const batch = (JSON.parse(String(init?.body)) as { batch: { id: string }[] }).batch;
  return jsonResponse(207, {
    successes: batch.map((event) => ({ id: event.id, status: 201 })),
    errors: [],
  });
};

const TRACE_FOUND = () => jsonResponse(200, { id: "probe", name: "probe" });

describe("checkLangfuseWriteMode", () => {
  it("reports not_configured when a credential is missing", async () => {
    const fetchImpl = vi.fn();
    const result = await checkLangfuseWriteMode({
      ...CREDENTIALS,
      secretKey: "",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.status).toBe("not_configured");
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("accepts an instance that stores all three event types and reads them back", async () => {
    const fetchImpl = router({ ingestion: ACCEPTED, readBack: TRACE_FOUND });

    const result = await checkLangfuseWriteMode({
      ...CREDENTIALS,
      ...NO_WAIT,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("ok");
    expect(result.rejectedEventTypes).toEqual([]);
  });

  // The second half of "accepted is not stored". `LANGFUSE_MIGRATION_V4_WRITE_MODE`
  // is read by langfuse-web AND langfuse-worker; flipping only the web service
  // buys a clean 207 for events nothing ever persists.
  it("fails when ingestion accepts the batch but the trace never reads back", async () => {
    const fetchImpl = router({
      ingestion: ACCEPTED,
      readBack: () => jsonResponse(404, { message: "Trace not found" }),
    });

    const result = await checkLangfuseWriteMode({
      ...CREDENTIALS,
      ...NO_WAIT,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("not_readable");
    expect(result.remedy).toContain("langfuse-worker");
  });

  it("keeps polling the read API rather than judging on the first 404", async () => {
    let reads = 0;
    const fetchImpl = router({
      ingestion: ACCEPTED,
      readBack: () => {
        reads += 1;
        // Ingestion is queued: a healthy instance is routinely not readable yet.
        return reads < 3 ? jsonResponse(404, { message: "Trace not found" }) : TRACE_FOUND();
      },
    });

    const result = await checkLangfuseWriteMode({
      ...CREDENTIALS,
      ...NO_WAIT,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
    expect(reads).toBe(3);
  });

  it("does not spend a read-back call when ingestion already refused the batch", async () => {
    const readBack = vi.fn(TRACE_FOUND);
    const fetchImpl = router({
      ingestion: (init) => {
        const batch = (JSON.parse(String(init?.body)) as { batch: { id: string }[] }).batch;
        return jsonResponse(207, {
          successes: [],
          errors: batch.map((event) => ({ id: event.id, status: 400 })),
        });
      },
      readBack,
    });

    const result = await checkLangfuseWriteMode({
      ...CREDENTIALS,
      ...NO_WAIT,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.status).toBe("events_only");
    expect(readBack).not.toHaveBeenCalled();
  });

  // The regression this whole module exists for: HTTP 207 with per-event
  // rejections is what an `events_only` v4 instance returns, and the SDK treats
  // it as a successful flush.
  it("flags events_only from the per-event errors inside a 207", async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const batch = (JSON.parse(String(init?.body)) as { batch: { id: string }[] }).batch;
      return jsonResponse(207, {
        successes: [],
        errors: batch.map((event) => ({
          id: event.id,
          status: 400,
          message: "Event type not accepted",
          error: "LANGFUSE_MIGRATION_V4_WRITE_MODE is events_only",
        })),
      });
    });

    const result = await checkLangfuseWriteMode({
      ...CREDENTIALS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("events_only");
    expect(result.rejectedEventTypes).toEqual([
      "trace-create",
      "generation-create",
      "generation-update",
    ]);
    expect(result.remedy).toContain("LANGFUSE_MIGRATION_V4_WRITE_MODE=dual");
  });

  it("reads a bare array of verdicts as well as { errors }", async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const batch = (JSON.parse(String(init?.body)) as { batch: { id: string }[] }).batch;
      return jsonResponse(
        207,
        batch.map((event) => ({ id: event.id, status: 400, message: "Event type not accepted" })),
      );
    });

    const result = await checkLangfuseWriteMode({
      ...CREDENTIALS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.status).toBe("events_only");
    expect(result.rejectedEventTypes).toHaveLength(3);
  });

  it("does not treat a per-event success verdict as a rejection", async () => {
    const fetchImpl = router({
      ingestion: (init) => {
        const batch = (JSON.parse(String(init?.body)) as { batch: { id: string }[] }).batch;
        return jsonResponse(
          207,
          batch.map((event) => ({ id: event.id, status: 201 })),
        );
      },
      readBack: TRACE_FOUND,
    });

    const result = await checkLangfuseWriteMode({
      ...CREDENTIALS,
      ...NO_WAIT,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
  });

  it("reports unauthorized rather than events_only on a key failure", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, { message: "unauthorized" }));

    const result = await checkLangfuseWriteMode({
      ...CREDENTIALS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.status).toBe("unauthorized");
    expect(result.reason).not.toContain(CREDENTIALS.secretKey);
  });

  it("reports unreachable when the ingestion endpoint cannot be called", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    });

    const result = await checkLangfuseWriteMode({
      ...CREDENTIALS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.status).toBe("unreachable");
    expect(result.ok).toBe(false);
  });

  it("sends no learner reference and no input/output content in the probe", async () => {
    let sent = "";
    const fetchImpl = router({
      ingestion: (init) => {
        sent = String(init?.body);
        return jsonResponse(207, { errors: [] });
      },
      readBack: TRACE_FOUND,
    });

    await checkLangfuseWriteMode({
      ...CREDENTIALS,
      ...NO_WAIT,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const batch = (JSON.parse(sent) as { batch: { body: Record<string, unknown> }[] }).batch;
    expect(batch).toHaveLength(3);
    for (const event of batch) {
      expect(event.body).not.toHaveProperty("input");
      expect(event.body).not.toHaveProperty("output");
      expect(event.body).not.toHaveProperty("userId");
      expect(event.body).not.toHaveProperty("metadata");
    }
  });
});
