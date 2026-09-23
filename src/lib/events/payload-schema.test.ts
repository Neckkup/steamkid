/**
 * The ten cases `docs/event-payload-dsl.md` requires the compiler to ship with,
 * plus the closure check on the emitted keyword set.
 *
 * The document is explicit about why per-event coverage is not enough: all 39
 * events can compile while every hash field is wrong, because the failure is in
 * how one production is *read*, not in whether it was read at all.
 */

import { describe, expect, it } from "vitest";

import { answerHash } from "./hash";
import { validateAgainstSchema } from "./json-schema";
import {
  assertRegistryInvariants,
  compileEventPayloadSchema,
  compileRegistry,
  compileTypeHint,
  FORMAT_NAMES,
  getPayloadSchema,
  PayloadSchemaError,
  type JsonSchema,
} from "./payload-schema";
import { parsePayloadType } from "./payload-type";
import { EVENT_NAMES, getEventDefinition, MAX_PAYLOAD_STRING_LENGTH } from "./registry";

function accepts(eventName: string, payload: Record<string, unknown>): boolean {
  return validateAgainstSchema(getPayloadSchema(eventName)!, payload).length === 0;
}

const CLOSED_KEYWORDS = new Set([
  "type",
  "enum",
  "pattern",
  "format",
  "maxLength",
  "items",
  "maxItems",
  "properties",
  "additionalProperties",
  "propertyNames",
  "maxProperties",
  "anyOf",
]);

/**
 * A compiled schema must be a document we can actually evaluate. `{}` would be
 * a valid JSON Schema and would validate everything, so "valid" here means
 * "declares a type or an anyOf, and uses no keyword we silently ignore".
 */
function assertEvaluable(schema: JsonSchema, where: string): void {
  for (const keyword of Object.keys(schema)) {
    expect(CLOSED_KEYWORDS.has(keyword), `${where}: unknown keyword ${keyword}`).toBe(true);
  }
  expect(schema.type !== undefined || schema.anyOf !== undefined, `${where}: permissive {}`).toBe(
    true,
  );

  if (schema.items) assertEvaluable(schema.items, `${where}.items`);
  if (schema.propertyNames) assertEvaluable(schema.propertyNames, `${where}.propertyNames`);
  if (schema.additionalProperties) {
    assertEvaluable(schema.additionalProperties, `${where}.additionalProperties`);
  }
  for (const [field, child] of Object.entries(schema.properties ?? {})) {
    assertEvaluable(child, `${where}.${field}`);
  }
  for (const [index, branch] of (schema.anyOf ?? []).entries()) {
    assertEvaluable(branch, `${where}.anyOf[${index}]`);
  }
}

describe("payload schema compiler", () => {
  it("compiles every event in the registry into an evaluable schema", () => {
    const compiled = compileRegistry();
    expect(compiled.size).toBe(EVENT_NAMES.length);

    for (const [name, schema] of compiled) {
      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(false);
      expect(Object.keys(schema.properties ?? {})).toEqual(
        Object.keys(getEventDefinition(name)!.payload),
      );
      assertEvaluable(schema, name);
    }
  });

  it("accepts an empty hash, because answerHash('') is empty by design", () => {
    expect(accepts("item.answer_changed", { from_hash: "" })).toBe(true);
  });

  it("accepts a real answerHash() output", async () => {
    const hash = await answerHash("มะม่วงมี 3 ผล");
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(accepts("item.answer_changed", { from_hash: hash, to_hash: hash })).toBe(true);
  });

  it("rejects the format name itself as a value", () => {
    // The regression the DSL document exists to prevent: string(sha256_16)
    // compiled as enum:["sha256_16"] dead-letters every real hash.
    expect(accepts("item.answer_changed", { from_hash: "sha256_16" })).toBe(false);
  });

  it("treats a single-member enum as an enum", () => {
    expect(accepts("consent.granted", { method: "guardian_web_verified_email" })).toBe(true);
    expect(accepts("consent.granted", { method: "other" })).toBe(false);
  });

  it("parses int enum alternatives as numbers", () => {
    expect(accepts("lesson.scroll_depth", { pct: 50 })).toBe(true);
    expect(accepts("lesson.scroll_depth", { pct: "50" })).toBe(false);
    expect(accepts("lesson.scroll_depth", { pct: 30 })).toBe(false);
  });

  it("accepts a map of unknown keys to numbers", () => {
    expect(
      accepts("item.presented", { skill_weights: { "sci.forces.1": 0.6, "math.frac.2": 0.4 } }),
    ).toBe(true);
    expect(accepts("item.presented", { skill_weights: { "sci.forces.1": "0.6" } })).toBe(false);
  });

  it("compiles uuid|null to a nullable uuid that still checks the pattern", () => {
    expect(accepts("session.heartbeat", { lesson_id: null })).toBe(true);
    expect(
      accepts("session.heartbeat", { lesson_id: "018f2b3c-4d5e-7f80-9a1b-2c3d4e5f6071" }),
    ).toBe(true);
    expect(accepts("session.heartbeat", { lesson_id: "nope" })).toBe(false);
    // Uppercase hex is not what uuidv7() emits, and ids are join keys.
    expect(
      accepts("session.heartbeat", { lesson_id: "018F2B3C-4D5E-7F80-9A1B-2C3D4E5F6071" }),
    ).toBe(false);
  });

  it("holds the FORMATS-vs-enum invariant over the registry as it is", () => {
    expect(() => assertRegistryInvariants()).not.toThrow();

    // And the parser agrees with this module about which names are formats.
    for (const name of FORMAT_NAMES) {
      expect(parsePayloadType(`string(${name})`)).toEqual({ kind: "format", format: name });
    }
  });

  it("throws on an unknown type hint instead of compiling to {}", () => {
    expect(() => compileTypeHint("blob")).toThrow(PayloadSchemaError);
    expect(() => compileTypeHint("string[][]")).toThrow(PayloadSchemaError);
    expect(() =>
      compileEventPayloadSchema({
        name: "test.invented",
        version: 1,
        group: "test",
        trigger: "test",
        payload: { essay: "freetext" },
        piiClass: "none",
        retentionDays: 1,
        exportable: false,
      }),
    ).toThrow(/test\.invented\.essay/);
  });

  it("caps every declared string at the registry limit", () => {
    const long = "ก".repeat(MAX_PAYLOAD_STRING_LENGTH + 1);
    expect(accepts("lesson.section_dwell", { section_id: long })).toBe(false);
    expect(accepts("session.started", { app_version: long })).toBe(false);
  });
});
