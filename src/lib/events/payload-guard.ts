/**
 * The guard that does not consult the registry.
 *
 * `payload-schema.ts` rejects a child's essay because the field it arrived in
 * is declared `string[]` with `maxLength: 200`. That is the right reason, and
 * it depends on the declaration being right. This module rejects the same essay
 * for a reason that survives a wrong declaration: **no string anywhere in an
 * event payload, at any depth, in a key or a value, may be longer than
 * `MAX_PAYLOAD_STRING_LENGTH`.**
 *
 * Two guards where one would do, because the cost of the miss is asymmetric.
 * `submission.revised_after_feedback` is declared `piiClass: "none"`,
 * `exportable: true`, retained 1095 days: a leak here is a child's words inside
 * a training export, labelled as containing no personal data, in an append-only
 * table that is expensive to walk back. A redundant check is cheap.
 *
 * PRO-22 found the hole on the client side (`criteria_addressed:
 * [<7,011 characters>]` passed a guard that only looked at top-level strings).
 * The lesson is not "fix the array case" — it is that a guard which only looks
 * where it expects trouble keeps finding it somewhere else.
 */

import { MAX_PAYLOAD_COLLECTION_SIZE } from "./payload-type";
import { MAX_PAYLOAD_STRING_LENGTH } from "./registry";

/**
 * Deepest nesting a legal payload reaches: the payload object, a field, and an
 * array item or map value. Four leaves room the grammar does not use.
 */
export const MAX_PAYLOAD_DEPTH = 4;

/**
 * Outer bound on one serialised payload. The string and collection caps already
 * bound the legal maximum (a `string[]` of 50 × 200 characters is ~10 KB), so
 * this only ever fires on something the other caps would also reject — it is
 * the cheap check that runs before we walk anything.
 */
export const MAX_PAYLOAD_BYTES = 16 * 1024;

export type PayloadGuardViolation =
  | { readonly kind: "oversized_string"; readonly path: string; readonly length: number }
  | { readonly kind: "oversized_collection"; readonly path: string; readonly size: number }
  | { readonly kind: "too_deep"; readonly path: string }
  | { readonly kind: "unserialisable"; readonly path: string };

/**
 * Walk a payload and report everything answer-shaped in it.
 *
 * Runs before schema validation so the metric says `oversized_string` rather
 * than `maxLength`, which is the difference between "somebody's text is leaking
 * into the pipe" and "a field is the wrong type".
 */
export function scanPayload(payload: unknown): PayloadGuardViolation[] {
  const violations: PayloadGuardViolation[] = [];
  walk(payload, "payload", 0, violations);
  return violations;
}

function walk(
  value: unknown,
  path: string,
  depth: number,
  violations: PayloadGuardViolation[],
): void {
  if (depth > MAX_PAYLOAD_DEPTH) {
    violations.push({ kind: "too_deep", path });
    return;
  }

  if (typeof value === "string") {
    if (value.length > MAX_PAYLOAD_STRING_LENGTH) {
      violations.push({ kind: "oversized_string", path, length: value.length });
    }
    return;
  }

  if (value === null || typeof value === "number" || typeof value === "boolean") return;

  if (Array.isArray(value)) {
    if (value.length > MAX_PAYLOAD_COLLECTION_SIZE) {
      violations.push({ kind: "oversized_collection", path, size: value.length });
    }
    value.forEach((item, index) => walk(item, `${path}[${index}]`, depth + 1, violations));
    return;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > MAX_PAYLOAD_COLLECTION_SIZE) {
      violations.push({ kind: "oversized_collection", path, size: entries.length });
    }
    for (const [key, entry] of entries) {
      const child = `${path}.${key}`;
      if (key.length > MAX_PAYLOAD_STRING_LENGTH) {
        violations.push({ kind: "oversized_string", path: `${child} (key)`, length: key.length });
      }
      walk(entry, child, depth + 1, violations);
    }
    return;
  }

  // undefined, function, symbol, bigint: nothing that survived JSON.parse, so
  // this is a caller passing us a live object rather than a parsed request.
  violations.push({ kind: "unserialisable", path });
}

/** Serialised size, or null when the value is not JSON at all. */
export function payloadByteLength(payload: unknown): number | null {
  try {
    return new TextEncoder().encode(JSON.stringify(payload) ?? "").length;
  } catch {
    return null;
  }
}

/**
 * A description of a payload's *shape*, with no value in it.
 *
 * This is what a dead-letter row and a log line get. A rejected event still has
 * to be debuggable — "which field, what type, how long" answers almost every
 * question — but quarantining a child's essay in `events.dead_letter` would
 * only move the leak to a table nobody is watching.
 */
export function describePayload(payload: unknown): Record<string, string> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { "": describeValue(payload, 0) };
  }
  return Object.fromEntries(
    Object.entries(payload as Record<string, unknown>).map(([key, value]) => [
      key.length > MAX_PAYLOAD_STRING_LENGTH ? `<key len=${key.length}>` : key,
      describeValue(value, 0),
    ]),
  );
}

function describeValue(value: unknown, depth: number): string {
  if (value === null) return "null";
  if (typeof value === "string") return `string(len=${value.length})`;
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "number";
  if (typeof value === "boolean") return "boolean";
  if (depth >= 2) return "…";

  if (Array.isArray(value)) {
    const first = value.length > 0 ? describeValue(value[0], depth + 1) : "";
    return `array[${value.length}]${first ? `<${first}>` : ""}`;
  }

  if (typeof value === "object") {
    return `object{${Object.keys(value as Record<string, unknown>).length}}`;
  }

  return typeof value;
}
