import { describe, expect, it } from "vitest";

import { ActivityClock, HEARTBEAT_INTERVAL_MS, INTERACTION_TIMEOUT_MS } from "./activity";
import type { EventEnvelope } from "./envelope";
import { uuidv7 } from "./envelope";
import { answerCharCount, answerHash } from "./hash";
import { checkPayloadValue, MAX_PAYLOAD_COLLECTION_SIZE, parsePayloadType } from "./payload-type";
import {
  EVENT_NAMES,
  getEventDefinition,
  MAX_PAYLOAD_STRING_LENGTH,
  REGISTRY_VERSION,
} from "./registry";
import { BehaviorTracker, nextHeartbeat, type TrackerViolation } from "./tracker";

function makeTracker(
  overrides: {
    consentGranted?: boolean;
    send?: (batch: readonly EventEnvelope[]) => Promise<boolean>;
    maxBatchSize?: number;
    maxQueueSize?: number;
  } = {},
) {
  const sent: EventEnvelope[][] = [];
  const violations: TrackerViolation[] = [];
  let clock = 1_700_000_000_000;

  const tracker = new BehaviorTracker({
    sessionId: "11111111-1111-7111-8111-111111111111",
    consentGranted: overrides.consentGranted ?? true,
    now: () => (clock += 1),
    randomBytes: (length) => new Uint8Array(length).fill(0xab),
    maxBatchSize: overrides.maxBatchSize,
    maxQueueSize: overrides.maxQueueSize,
    onViolation: (violation) => violations.push(violation),
    transport: {
      send: async (batch) => {
        if (overrides.send) return overrides.send(batch);
        sent.push([...batch]);
        return true;
      },
    },
  });

  return { tracker, sent, violations };
}

describe("registry", () => {
  it("carries all 39 events decided on PRO-3", () => {
    expect(EVENT_NAMES).toHaveLength(39);
    expect(REGISTRY_VERSION).toBe("1.0.0");
  });

  it("keeps the ordering guarantee item.presented → item.first_input emittable", () => {
    expect(getEventDefinition("item.presented")?.payload).toHaveProperty("skill_weights");
    expect(getEventDefinition("item.first_input")?.payload).toHaveProperty(
      "latency_ms_since_presented",
    );
  });

  it("declares hash fields, never text fields, for learner-authored content", () => {
    const changed = getEventDefinition("item.answer_changed");
    expect(changed?.piiClass).toBe("content_hash");
    expect(Object.keys(changed?.payload ?? {})).toEqual(
      expect.arrayContaining(["from_hash", "to_hash"]),
    );
    expect(Object.keys(changed?.payload ?? {})).not.toContain("answer");
  });
});

describe("payload type hints", () => {
  const hints = EVENT_NAMES.flatMap((name) =>
    Object.entries(getEventDefinition(name)?.payload ?? {}).map(
      ([field, hint]) => [`${name}.${field}`, hint] as const,
    ),
  );

  // The tracker refuses any field whose hint it cannot parse, so an unreadable
  // hint would silently stop an event from ever being emitted. Better to find
  // out here than from a hole in the dataset months later.
  it("parses every hint in all 39 registry events", () => {
    const unparsable = hints.filter(([, hint]) => parsePayloadType(hint) === null);
    expect(unparsable).toEqual([]);
    expect(hints.length).toBeGreaterThan(100);
  });

  it("reads string(sha256_16) as a hash format, not a single-member enum", async () => {
    const hash = parsePayloadType("string(sha256_16)");
    expect(hash).toEqual({ kind: "format", format: "sha256_16" });
    expect(checkPayloadValue(hash!, await answerHash("แรงเสียดทาน"))).toBeNull();
    expect(checkPayloadValue(hash!, "")).toBeNull();

    expect(parsePayloadType("string(guardian_web_verified_email)")).toEqual({
      kind: "enum",
      base: "string",
      alternatives: ["guardian_web_verified_email"],
    });
  });

  it("checks every member of a string[], not just the array itself", () => {
    const tags = parsePayloadType("string[]")!;
    expect(checkPayloadValue(tags, ["a", "b"])).toBeNull();
    expect(checkPayloadValue(tags, ["a", "x".repeat(MAX_PAYLOAD_STRING_LENGTH + 1)])).toBe(
      "oversized_value",
    );
    expect(checkPayloadValue(tags, ["a", 1])).toBe("invalid_type");
    expect(checkPayloadValue(tags, "a")).toBe("invalid_type");
  });

  it("checks both sides of object<string,number>", () => {
    const weights = parsePayloadType("object<string,number>")!;
    expect(checkPayloadValue(weights, { "sci.forces": 0.7 })).toBeNull();
    expect(checkPayloadValue(weights, { "sci.forces": "0.7" })).toBe("invalid_type");
    expect(checkPayloadValue(weights, { ["x".repeat(201)]: 1 })).toBe("oversized_value");
    expect(checkPayloadValue(weights, { nested: Number.NaN })).toBe("invalid_type");
  });

  it("accepts null only where the hint says |null", () => {
    expect(checkPayloadValue(parsePayloadType("uuid|null")!, null)).toBeNull();
    expect(checkPayloadValue(parsePayloadType("uuid")!, null)).toBe("invalid_type");
  });
});

describe("BehaviorTracker", () => {
  it("builds an envelope the ingest contract accepts", async () => {
    const { tracker, sent } = makeTracker();

    tracker.track("lesson.opened", { lesson_id: "l1", content_version: 3 }, { lesson_id: "l1" });
    await tracker.flush();

    const event = sent[0]?.[0];
    expect(event).toMatchObject({
      event_name: "lesson.opened",
      event_version: 1,
      client_seq: 1,
      registry_version: "1.0.0",
      lesson_id: "l1",
      correlation_id: null,
    });
    expect(event?.event_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-/);
    expect(event?.occurred_at).toMatch(/Z$/);
  });

  it("never sends the learner id — the server derives it from the session", async () => {
    const { tracker, sent } = makeTracker();

    tracker.track("session.started", { device_class: "mobile" });
    await tracker.flush();

    expect(Object.keys(sent[0]?.[0] ?? {})).not.toContain("learner_id");
  });

  it("refuses an event name that is not in the registry", () => {
    const { tracker, violations } = makeTracker();

    expect(tracker.track("lesson.opened_typo", { lesson_id: "l1" })).toBe(false);
    expect(tracker.pendingCount).toBe(0);
    expect(violations).toEqual([{ kind: "unknown_event", eventName: "lesson.opened_typo" }]);
  });

  it("refuses a payload field the registry does not declare", () => {
    const { tracker, violations } = makeTracker();

    expect(tracker.track("item.answer_changed", { item_id: "i1", answer_text: "แรงเสียดทาน" })).toBe(
      false,
    );
    expect(violations).toEqual([
      { kind: "undeclared_field", eventName: "item.answer_changed", field: "answer_text" },
    ]);
  });

  it("refuses a declared field holding something answer-shaped", () => {
    const { tracker, violations } = makeTracker();

    expect(tracker.track("page.viewed", { route: "x".repeat(201) })).toBe(false);
    expect(violations).toEqual([
      { kind: "oversized_value", eventName: "page.viewed", field: "route" },
    ]);
  });

  // PRO-21. The length guard used to look only at top-level strings, so a
  // child's essay inside a `string[]` reached `POST /api/events` — on an event
  // kept for 730 days and marked exportable.
  it("refuses an answer hidden inside a string[] field", () => {
    const { tracker, violations } = makeTracker();
    const childEssay = `หนูชื่อ... ${"I rewrote my volcano essay because ".repeat(200)}`;

    expect(
      tracker.track("submission.revised_after_feedback", {
        submission_id: "sub-1",
        verdict_id: "v-1",
        draft_no: 2,
        ms_since_feedback_viewed: 900,
        criteria_addressed: [childEssay],
      }),
    ).toBe(false);
    expect(tracker.pendingCount).toBe(0);
    expect(violations).toEqual([
      {
        kind: "oversized_value",
        eventName: "submission.revised_after_feedback",
        field: "criteria_addressed",
      },
    ]);
  });

  it("refuses an answer hidden inside an object where a string was declared", () => {
    const { tracker, violations } = makeTracker();

    expect(
      tracker.track("lesson.section_dwell", {
        lesson_id: "l-1",
        section_id: { answer: "y".repeat(3000) },
        active_ms: 10,
      }),
    ).toBe(false);
    expect(tracker.pendingCount).toBe(0);
    expect(violations).toEqual([
      { kind: "invalid_type", eventName: "lesson.section_dwell", field: "section_id" },
    ]);
  });

  it("refuses an essay chunked into many individually-legal array entries", () => {
    const { tracker, violations } = makeTracker();

    expect(
      tracker.track("feedback.dwell", {
        verdict_id: "v-1",
        active_ms: 10,
        expanded_criteria: Array.from({ length: MAX_PAYLOAD_COLLECTION_SIZE + 1 }, () =>
          "z".repeat(200),
        ),
      }),
    ).toBe(false);
    expect(violations).toEqual([
      { kind: "oversized_value", eventName: "feedback.dwell", field: "expanded_criteria" },
    ]);
  });

  it("refuses a number where the registry declared an int, and a string where it declared a number", () => {
    const { tracker, violations } = makeTracker();

    expect(tracker.track("lesson.closed", { lesson_id: "l1", active_ms: 10.5 })).toBe(false);
    expect(tracker.track("media.completed", { watched_ratio: "0.8" })).toBe(false);
    expect(violations.map((violation) => violation.kind)).toEqual(["invalid_type", "invalid_type"]);
  });

  it("still accepts the collection shapes the registry really declares", async () => {
    const { tracker, sent } = makeTracker();

    expect(
      tracker.track("lesson.section_dwell", {
        lesson_id: "l1",
        section_id: "intro",
        active_ms: 10,
        skill_tags: ["sci.forces", "sci.motion"],
      }),
    ).toBe(true);
    expect(
      tracker.track("item.presented", {
        item_id: "i1",
        attempt_no: 1,
        skill_weights: { "sci.forces": 0.7, "sci.motion": 0.3 },
      }),
    ).toBe(true);
    expect(tracker.track("page.viewed", { route: "/lesson/1", lesson_id: null })).toBe(true);

    await tracker.flush();
    expect(sent[0]).toHaveLength(3);
  });

  it("emits nothing before consent, except the consent events themselves", () => {
    const { tracker } = makeTracker({ consentGranted: false });

    expect(tracker.track("lesson.opened", { lesson_id: "l1" })).toBe(false);
    expect(tracker.track("consent.granted", { policy_version: "1.0" })).toBe(true);
    expect(tracker.pendingCount).toBe(1);
  });

  it("drops queued behaviour when consent is withdrawn mid-session", () => {
    const { tracker } = makeTracker();

    tracker.track("lesson.opened", { lesson_id: "l1" });
    tracker.track("lesson.scroll_depth", { lesson_id: "l1", pct: 50 });
    tracker.setConsent(false);

    expect(tracker.pendingCount).toBe(0);
    expect(tracker.track("consent.revoked", { policy_version: "1.0" })).toBe(true);
  });

  it("retries a failed batch instead of losing it, oldest first", async () => {
    let attempt = 0;
    const { tracker } = makeTracker({
      send: async () => {
        attempt += 1;
        return attempt > 1;
      },
    });

    tracker.track("lesson.opened", { lesson_id: "l1" });
    tracker.track("lesson.closed", { lesson_id: "l1", active_ms: 10 });

    await tracker.flush();
    expect(tracker.pendingCount).toBe(2);

    await tracker.flush();
    expect(tracker.pendingCount).toBe(0);
  });

  it("never lets a transport error escape to the caller", async () => {
    const { tracker, violations } = makeTracker({
      send: async () => {
        throw new Error("offline");
      },
    });

    tracker.track("lesson.opened", { lesson_id: "l1" });
    await expect(tracker.flush()).resolves.toBeUndefined();
    expect(violations).toEqual([{ kind: "transport_failed", batchSize: 1 }]);
    expect(tracker.pendingCount).toBe(1);
  });

  it("caps the queue on a dead connection and reports the loss", async () => {
    const { tracker, violations } = makeTracker({
      send: async () => false,
      maxBatchSize: 50,
      maxQueueSize: 3,
    });

    for (let index = 0; index < 5; index += 1) {
      tracker.track("lesson.scroll_depth", { lesson_id: "l1", pct: 25 });
    }

    expect(tracker.pendingCount).toBe(3);
    expect(violations).toContainEqual({ kind: "queue_overflow", dropped: 1 });
  });

  it("splits into batches of at most 50", async () => {
    const { tracker, sent } = makeTracker({ maxQueueSize: 1000 });

    for (let index = 0; index < 51; index += 1) {
      tracker.track("session.heartbeat", { active_ms_delta: 15_000 });
    }
    await tracker.flush();
    await tracker.flush();

    expect(sent[0]).toHaveLength(50);
    expect(tracker.pendingCount).toBe(0);
  });

  it("orders by client_seq, not by the device clock", async () => {
    const { tracker, sent } = makeTracker({ maxQueueSize: 1000 });

    tracker.track("item.presented", { item_id: "i1", attempt_no: 1 });
    tracker.track("item.first_input", { item_id: "i1", attempt_no: 1 });
    await tracker.flush();

    expect(sent[0]?.map((event) => event.client_seq)).toEqual([1, 2]);
    expect(sent[0]?.map((event) => event.event_name)).toEqual([
      "item.presented",
      "item.first_input",
    ]);
  });
});

describe("uuidv7", () => {
  it("sorts by time, which is what the partitioned table wants", () => {
    const early = uuidv7(1_700_000_000_000, (length) => new Uint8Array(length));
    const late = uuidv7(1_700_000_001_000, (length) => new Uint8Array(length));
    expect(early < late).toBe(true);
  });
});

describe("ActivityClock", () => {
  const start = 1_000_000;

  it("counts time only while the child is interacting", () => {
    const clock = new ActivityClock(start);

    clock.markInteraction(start + 5_000);
    expect(clock.activeMs(start + 5_000)).toBe(5_000);
  });

  it("stops counting two minutes after the last interaction", () => {
    const clock = new ActivityClock(start);

    const later = start + INTERACTION_TIMEOUT_MS + 300_000;
    expect(clock.isActive(later)).toBe(false);
    expect(clock.activeMs(later)).toBe(INTERACTION_TIMEOUT_MS);
  });

  it("stops counting the moment the tab is hidden", () => {
    const clock = new ActivityClock(start);

    clock.setVisible(false, start + 3_000);
    expect(clock.activeMs(start + 60_000)).toBe(3_000);

    clock.setVisible(true, start + 60_000);
    clock.markInteraction(start + 61_000);
    expect(clock.activeMs(start + 61_000)).toBe(4_000);
  });

  it("does not resume on its own when a hidden tab becomes visible again", () => {
    const clock = new ActivityClock(start);

    clock.setVisible(false, start + 1_000);
    clock.setVisible(true, start + INTERACTION_TIMEOUT_MS + 10_000);

    expect(clock.isActive(start + INTERACTION_TIMEOUT_MS + 10_000)).toBe(false);
  });

  it("reports heartbeat deltas without double counting", () => {
    const clock = new ActivityClock(start);

    clock.markInteraction(start + HEARTBEAT_INTERVAL_MS);
    expect(nextHeartbeat(clock, start + HEARTBEAT_INTERVAL_MS)).toEqual({
      active_ms_delta: HEARTBEAT_INTERVAL_MS,
    });

    clock.markInteraction(start + 2 * HEARTBEAT_INTERVAL_MS);
    expect(nextHeartbeat(clock, start + 2 * HEARTBEAT_INTERVAL_MS)).toEqual({
      active_ms_delta: HEARTBEAT_INTERVAL_MS,
    });
  });

  it("emits no heartbeat for a tab left open on the sofa", () => {
    const clock = new ActivityClock(start);
    const abandoned = start + INTERACTION_TIMEOUT_MS + HEARTBEAT_INTERVAL_MS;

    expect(nextHeartbeat(clock, abandoned)).toBeNull();
  });
});

describe("answerHash", () => {
  it("is stable across retyping and whitespace", async () => {
    expect(await answerHash("แรงเสียดทาน ทำให้ช้าลง")).toBe(
      await answerHash("  แรงเสียดทาน   ทำให้ช้าลง  "),
    );
  });

  it("changes when the answer changes", async () => {
    expect(await answerHash("ของหนักตกเร็วกว่า")).not.toBe(await answerHash("ของสองชิ้นตกพร้อมกัน"));
  });

  it("is short, hex, and not the answer", async () => {
    const hash = await answerHash("แรงเสียดทาน");
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(hash).not.toContain("แรง");
  });

  it("distinguishes an untouched box from a written one", async () => {
    expect(await answerHash("   ")).toBe("");
    expect(answerCharCount("  a b  ")).toBe(3);
  });
});
