/**
 * The ingest gate, including the PRO-22 reproduction fired straight at the
 * endpoint.
 *
 * The bug it pins: `criteria_addressed` is `string[]` on an event declared
 * `piiClass: "none"`, `exportable: true`, retained 1095 days. A child's
 * 7,011-character answer inside that array passed the client guard, which only
 * measured top-level strings. Even with the client fixed, the tab open on a
 * child's tablet is still running yesterday's build — so the assertions here
 * are about what the *server* does with that exact batch.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/events/route";

import {
  MAX_BATCH_SIZE,
  readBatch,
  validateBatch,
  validateEvent,
  BatchRejectedError,
} from "./ingest";
import { resetIngestMetrics, snapshotIngestMetrics } from "./ingest-metrics";
import { MAX_PAYLOAD_COLLECTION_SIZE } from "./payload-type";
import { MAX_PAYLOAD_STRING_LENGTH, REGISTRY_VERSION } from "./registry";
import { MemoryEventSink, setEventSink } from "./sink";
import { MAX_BATCH_SIZE as CLIENT_MAX_BATCH_SIZE } from "./tracker";

const RECEIVED_AT = "2026-09-18T12:00:00.000Z";

const SESSION_ID = "018f2b3c-4d5e-7f80-9a1b-2c3d4e5f6071";
const SUBMISSION_ID = "018f2b3c-4d5e-7f80-9a1b-2c3d4e5f6072";
const VERDICT_ID = "018f2b3c-4d5e-7f80-9a1b-2c3d4e5f6073";

/** The reported payload: one child's essay, in a field meant for tag strings. */
const CHILD_ESSAY = "ฉันคิดว่าน้ำแข็งละลายเพราะความร้อน ".repeat(206).slice(0, 7011);

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: "018f2b3c-4d5e-7f80-9a1b-2c3d4e5f6080",
    client_seq: 7,
    event_name: "submission.revised_after_feedback",
    event_version: 1,
    occurred_at: "2026-09-18T11:59:58.412Z",
    session_id: SESSION_ID,
    registry_version: REGISTRY_VERSION,
    lesson_id: null,
    item_id: null,
    submission_id: SUBMISSION_ID,
    path_step_id: null,
    verdict_id: VERDICT_ID,
    correlation_id: null,
    payload: {
      submission_id: SUBMISSION_ID,
      verdict_id: VERDICT_ID,
      draft_no: 2,
      ms_since_feedback_viewed: 41_200,
      criteria_addressed: ["evidence", "units"],
    },
    ...overrides,
  };
}

function withPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return envelope({ payload: { ...(envelope().payload as object), ...payload } });
}

beforeEach(() => {
  resetIngestMetrics();
  setEventSink(null);
});

describe("PRO-22 — the reported batch", () => {
  it("expresses the bug exactly as reported", () => {
    expect(CHILD_ESSAY.length).toBe(7011);
  });

  it("refuses a child's essay inside a string[]", () => {
    const result = validateEvent(withPayload({ criteria_addressed: [CHILD_ESSAY] }), RECEIVED_AT);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.record.reason).toBe("oversized_string");
    expect(result.record.detail).toEqual(["payload.criteria_addressed[0]: string of 7011 chars"]);
    expect(result.record.event_name).toBe("submission.revised_after_feedback");
  });

  it("quarantines the shape and never the text", () => {
    const result = validateEvent(withPayload({ criteria_addressed: [CHILD_ESSAY] }), RECEIVED_AT);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    const serialised = JSON.stringify(result.record);
    // Not a substring of the row, not a substring of any field name in it.
    expect(serialised).not.toContain(CHILD_ESSAY.slice(0, 40));
    expect(result.record.payload_shape).toEqual({
      submission_id: "string(len=36)",
      verdict_id: "string(len=36)",
      draft_no: "int",
      ms_since_feedback_viewed: "int",
      criteria_addressed: "array[1]<string(len=7011)>",
    });
  });

  it("counts the rejection instead of writing it quietly", async () => {
    const sink = new MemoryEventSink();
    const { accepted, rejected } = validateBatch(
      [envelope(), withPayload({ criteria_addressed: [CHILD_ESSAY] })],
      RECEIVED_AT,
    );
    await sink.accept(accepted);
    await sink.deadLetter(rejected);

    expect(sink.accepted).toHaveLength(1);
    expect(sink.deadLettered).toHaveLength(1);

    const metrics = snapshotIngestMetrics();
    expect(metrics.accepted).toBe(1);
    expect(metrics.rejected).toBe(1);
    expect(metrics.byReason).toEqual({ oversized_string: 1 });
    expect(metrics.byEventName).toEqual({ "submission.revised_after_feedback": 1 });
  });
});

describe("payload validation", () => {
  it("accepts a well-formed event", () => {
    const result = validateEvent(envelope(), RECEIVED_AT);
    expect(result.ok).toBe(true);
  });

  it("refuses a payload key the registry does not declare", () => {
    const result = validateEvent(withPayload({ answer_text: "12 cm" }), RECEIVED_AT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.record.reason).toBe("undeclared_payload_key");
    expect(result.record.detail).toContain("payload.answer_text: additionalProperties");
  });

  it("refuses a declared field holding the wrong type", () => {
    const wrongScalar = validateEvent(withPayload({ draft_no: "2" }), RECEIVED_AT);
    expect(wrongScalar.ok).toBe(false);
    if (!wrongScalar.ok) expect(wrongScalar.record.reason).toBe("payload_type_mismatch");

    // A field declared `string[]` holding an object used to be shapeless enough
    // to sail through every guard we had.
    const wrongShape = validateEvent(
      withPayload({ criteria_addressed: { evidence: true } }),
      RECEIVED_AT,
    );
    expect(wrongShape.ok).toBe(false);
    if (!wrongShape.ok) expect(wrongShape.record.reason).toBe("payload_type_mismatch");
  });

  it("refuses a long string nested in a map value and in a map key", () => {
    const long = "x".repeat(MAX_PAYLOAD_STRING_LENGTH + 1);

    const inKey = validateEvent(
      envelope({
        event_name: "item.presented",
        payload: { item_id: SUBMISSION_ID, attempt_no: 1, skill_weights: { [long]: 0.5 } },
      }),
      RECEIVED_AT,
    );
    expect(inKey.ok).toBe(false);
    if (!inKey.ok) {
      expect(inKey.record.reason).toBe("oversized_string");
      expect(inKey.record.detail[0]).toContain("(key)");
    }

    const inValue = validateEvent(
      envelope({
        event_name: "consent.granted",
        payload: { policy_version: "2026-09-18.v1", scopes: ["behaviour_events", long] },
      }),
      RECEIVED_AT,
    );
    expect(inValue.ok).toBe(false);
    if (!inValue.ok) expect(inValue.record.reason).toBe("oversized_string");
  });

  it("refuses an essay chunked into individually legal slices", () => {
    // 200 characters each, all legal on their own. Without a collection cap the
    // length guard is a formality.
    const slices = Array.from({ length: MAX_PAYLOAD_COLLECTION_SIZE + 1 }, () => "y".repeat(200));
    const result = validateEvent(withPayload({ criteria_addressed: slices }), RECEIVED_AT);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.record.reason).toBe("oversized_collection");
  });

  it("refuses an unknown event name and a version that is not the registry's", () => {
    const unknown = validateEvent(envelope({ event_name: "submission.exfiltrated" }), RECEIVED_AT);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.record.reason).toBe("unknown_event");

    const stale = validateEvent(envelope({ event_version: 2 }), RECEIVED_AT);
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.record.reason).toBe("event_version_mismatch");
      expect(stale.record.detail).toEqual(["expected v1, got v2"]);
    }
  });

  it("refuses an envelope with a missing or undeclared top-level field", () => {
    const missing = envelope();
    delete missing.session_id;
    const missingResult = validateEvent(missing, RECEIVED_AT);
    expect(missingResult.ok).toBe(false);
    if (!missingResult.ok) expect(missingResult.record.reason).toBe("malformed_envelope");

    const smuggled = validateEvent(envelope({ learner_id: "guessed-a-child" }), RECEIVED_AT);
    expect(smuggled.ok).toBe(false);
    if (!smuggled.ok) expect(smuggled.record.reason).toBe("malformed_envelope");
  });

  it("still accepts events from a client on an older registry version", () => {
    // The tab we cannot redeploy is the reason this endpoint validates at all;
    // refusing its whole stream would be the wrong way to win the argument.
    const result = validateEvent(envelope({ registry_version: "0.9.0" }), RECEIVED_AT);
    expect(result.ok).toBe(true);
  });
});

describe("batch handling", () => {
  it("reads both wire shapes and refuses anything else", () => {
    expect(readBatch([envelope()])).toHaveLength(1);
    expect(readBatch({ events: [envelope()] })).toHaveLength(1);
    expect(() => readBatch({ payload: [] })).toThrow(BatchRejectedError);
    expect(() => readBatch("nope")).toThrow(BatchRejectedError);
  });

  it("refuses a batch larger than the contract", () => {
    const oversized = Array.from({ length: MAX_BATCH_SIZE + 1 }, () => envelope());
    expect(() => readBatch(oversized)).toThrow(/batch_too_large/);
  });

  it("uses the same batch size the emitter does", () => {
    expect(MAX_BATCH_SIZE).toBe(CLIENT_MAX_BATCH_SIZE);
  });
});

describe("POST /api/events", () => {
  function post(body: unknown): Promise<Response> {
    return POST(
      new Request("http://localhost/api/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
  }

  it("fails closed when no store is wired, rather than accepting and dropping", async () => {
    const response = await post({ events: [envelope()] });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "event_store_unavailable" });
  });

  it("stores the good events, dead-letters the essay, and reports both", async () => {
    const sink = new MemoryEventSink();
    setEventSink(sink);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await post({
      events: [envelope(), withPayload({ criteria_addressed: [CHILD_ESSAY] })],
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      accepted: 1,
      rejected: 1,
      rejections: [
        {
          event_id: "018f2b3c-4d5e-7f80-9a1b-2c3d4e5f6080",
          event_name: "submission.revised_after_feedback",
          reason: "oversized_string",
          detail: ["payload.criteria_addressed[0]: string of 7011 chars"],
        },
      ],
    });

    expect(sink.accepted).toHaveLength(1);
    expect(sink.accepted[0]!.payload).toEqual({
      submission_id: SUBMISSION_ID,
      verdict_id: VERDICT_ID,
      draft_no: 2,
      ms_since_feedback_viewed: 41_200,
      criteria_addressed: ["evidence", "units"],
    });
    expect(sink.deadLettered.map((record) => record.reason)).toEqual(["oversized_string"]);

    // The rejection is loud, and the log line carries no child text either.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).not.toContain(CHILD_ESSAY.slice(0, 40));
    warn.mockRestore();
  });

  it("answers 400 to a body that is not JSON and 413 to an oversized batch", async () => {
    setEventSink(new MemoryEventSink());

    const broken = await post("{not json");
    expect(broken.status).toBe(400);

    const oversized = await post({
      events: Array.from({ length: MAX_BATCH_SIZE + 1 }, () => envelope()),
    });
    expect(oversized.status).toBe(413);
  });
});
