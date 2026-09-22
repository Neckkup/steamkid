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

  it("accepts an instance that stores all three event types", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(207, { successes: [{ id: "e0", status: 201 }], errors: [] }),
    );

    const result = await checkLangfuseWriteMode({
      ...CREDENTIALS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("ok");
    expect(result.rejectedEventTypes).toEqual([]);
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
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const batch = (JSON.parse(String(init?.body)) as { batch: { id: string }[] }).batch;
      return jsonResponse(
        207,
        batch.map((event) => ({ id: event.id, status: 201 })),
      );
    });

    const result = await checkLangfuseWriteMode({
      ...CREDENTIALS,
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
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      sent = String(init?.body);
      return jsonResponse(207, { errors: [] });
    });

    await checkLangfuseWriteMode({
      ...CREDENTIALS,
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
