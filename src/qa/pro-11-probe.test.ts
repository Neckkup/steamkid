/**
 * QA probe pack for PRO-11 — adversarial neighbours of the PRO-21/22/23 fixes.
 *
 * The regression pack proves the reported repro is closed. This pack looks for
 * the hole one step to the side, which is where the PRO-22 comment itself says
 * these guards keep reappearing.
 *
 * To run: drop at `src/qa/pro-11-probe.test.ts`, then
 *   npx vitest run src/qa/
 */

import { describe, expect, it } from "vitest";

import { readBatch, validateEvent, MAX_BATCH_SIZE } from "@/lib/events/ingest";
import { getPayloadSchema } from "@/lib/events/payload-schema";
import registryFile from "@/lib/events/event-registry.v1.json";
import {
  CONSENT_EXEMPT_EVENTS,
  EVENT_NAMES,
  getEventDefinition,
} from "@/lib/events/registry";
import { redactDeep, scrubText } from "@/lib/privacy/redact";

const RECEIVED_AT = "2026-09-19T08:00:00.000Z";

describe("probe: the gate covers every registered event, not just the reported one", () => {
  it("every registry event compiles to a payload schema", () => {
    const missing = EVENT_NAMES.filter((name) => !getPayloadSchema(name));
    expect(missing).toEqual([]);
  });

  it("an unknown event never reaches the non-null schema assertion", () => {
    // validateEvent does `getPayloadSchema(name)!`. If unknown-event rejection
    // were ever reordered after it, this would throw instead of dead-lettering.
    expect(() =>
      validateEvent(
        {
          event_id: "018f0000-0000-7000-8000-00000000000a",
          client_seq: 1,
          event_name: "not.a.real.event",
          event_version: 1,
          occurred_at: "2026-09-19T07:59:59.000Z",
          session_id: "018f0000-0000-7000-8000-00000000000b",
          registry_version: "1.0.0",
          payload: {},
        },
        RECEIVED_AT,
      ),
    ).not.toThrow();
  });

  it("the hardcoded consent-exempt list still matches the registry", () => {
    // CONSENT_EXEMPT_EVENTS is a literal array, not derived from the registry's
    // own `requiredConsentScope` field (which `EventDefinition` does not even
    // model). If a third service_operation event is ever added, the tracker
    // gates it on behaviour_events consent and it is silently never emitted.
    const raw = registryFile as {
      events: { name: string; requiredConsentScope?: string }[];
    };
    const declaredExempt = raw.events
      .filter((e) => e.requiredConsentScope && e.requiredConsentScope !== "behaviour_events")
      .map((e) => e.name)
      .sort();

    expect(declaredExempt).toEqual([...CONSENT_EXEMPT_EVENTS].sort());

    for (const name of CONSENT_EXEMPT_EVENTS) {
      const definition = getEventDefinition(name);
      expect(definition, `${name} missing from registry`).toBeDefined();
      // Exempt from behaviour_events, but must never reach a training export.
      expect(definition!.exportable, `${name} exportable`).toBe(false);
    }
  });
});

describe("probe: batch boundary", () => {
  it("accepts both documented batch shapes and caps the size", () => {
    expect(readBatch([]).length).toBe(0);
    expect(readBatch({ events: [] }).length).toBe(0);
    expect(() => readBatch({ nope: [] })).toThrow();
    expect(() => readBatch(new Array(MAX_BATCH_SIZE).fill({}))).not.toThrow();
    expect(() => readBatch(new Array(MAX_BATCH_SIZE + 1).fill({}))).toThrow();
  });
});

describe("probe: redactDeep cost on a wide shared graph", () => {
  it("does not blow up on a diamond graph the ancestry fix re-walks", () => {
    // The fix trades a global WeakSet for path ancestry, which means a shared
    // node is walked once per path that reaches it. Build the worst legal case
    // inside maxDepth and assert it stays fast.
    let level: unknown = { leaf: "x" };
    for (let i = 0; i < 8; i++) {
      level = { a: level, b: level };
    }
    const started = Date.now();
    const out = redactDeep(level);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(out).toBeTruthy();
  });

  it("truncates rather than recursing past maxDepth", () => {
    let deep: unknown = "bottom";
    for (let i = 0; i < 20; i++) deep = { next: deep };
    expect(JSON.stringify(redactDeep(deep))).toContain("[TRUNCATED]");
  });
});

describe("probe: scrubText on realistic child schoolwork", () => {
  const clean: [string, string][] = [
    ["place value", "1000000 has 7 digits"],
    ["decimal", "3.14159265"],
    ["iso date", "the eruption was on 2024-01-15"],
    ["measurements", "12 cm by 45 cm by 7 cm"],
    ["year range", "1980-1990"],
    ["time", "at 10:30 we measured 250 ml"],
    ["spaced series", "10 20 30 40 50 60 70 80 90 100"],
  ];

  for (const [label, text] of clean) {
    it(`leaves ${label} untouched: ${text}`, () => {
      expect(scrubText(text)).toBe(text);
    });
  }

  /**
   * FINDING (QA, PRO-11), fixed in PRO-32: PRO-23 narrowed PHONE_RE for maths,
   * but two shapes a STEAM app produces routinely were still redacted.
   * Assertions flipped to the intended behaviour now that the fix has landed.
   */
  describe("PRO-32 — science magnitudes and dashed arithmetic survive", () => {
    it("9+ contiguous digits: science magnitudes", () => {
      expect(scrubText("the sun is 149600000 km away")).toBe(
        "the sun is 149600000 km away",
      );
      expect(scrubText("light travels 299792458 m/s")).toBe(
        "light travels 299792458 m/s",
      );
    });

    it("dash-separated arithmetic reads as a phone number", () => {
      expect(scrubText("1000-200-300 = 500")).toBe("1000-200-300 = 500");
    });

    it("but a real number never rides in on that exemption", () => {
      // Leading 0 is a trunk prefix; no unit or operator can rescue it.
      expect(scrubText("0812345678 km")).toBe("[REDACTED] km");
      expect(scrubText("081-234-5678 = call me")).toBe("[REDACTED] = call me");
      // A contact word in the phrase vetoes the exemption.
      expect(scrubText("call 812345678 m")).toBe("call [REDACTED] m");
    });
  });
});
