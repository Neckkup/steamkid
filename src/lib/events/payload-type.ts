/**
 * The payload type language of `event-registry.v1.json`, parsed.
 *
 * `docs/event-payload-dsl.md` is the normative grammar. It was written for the
 * server-side compiler that turns each type hint into the JSON Schema stored in
 * `events.event_registry.payload_schema` (PRO-7). This module reads the same
 * grammar in the browser, for a narrower job: deciding whether a value the app
 * is about to put in an event matches the shape the registry declared.
 *
 * Why the client checks types at all (PRO-21): the only guard used to be "a
 * top-level string must be shorter than 200 characters". An array or an object
 * matched neither branch, so `criteria_addressed: [<a child's 7,000-character
 * essay>]` was accepted, queued, and posted to `/api/events` — into an event
 * declared `piiClass: "none"`, `exportable: true`, kept for 730 days. Checking
 * the declared type instead of the top-level runtime type closes that hole for
 * every field at once rather than one field at a time.
 *
 * Deliberately **structural** only. `uuid` is checked as "a string", not
 * against the uuid pattern, and `string(a|b|c)` is checked as "a string", not
 * against the alternatives. Value-domain validation belongs to the compiled
 * JSON Schema at ingest, which is authoritative and can reject without losing
 * the event to a silent client-side drop. What the client owes the pipe is that
 * no free text gets in, and free text is a shape problem.
 */

import { MAX_PAYLOAD_STRING_LENGTH } from "./registry";

/**
 * Cap on how many entries an array or map field may carry.
 *
 * Nothing in the registry needs more: `skill_tags`, `scopes`,
 * `criteria_addressed` and `expanded_criteria` are short tag lists, and
 * `skill_weights` holds the skills of a single item. Without a cap, the length
 * guard is trivially defeated by chunking — 200-character slices of the same
 * essay, each one individually legal.
 */
export const MAX_PAYLOAD_COLLECTION_SIZE = 50;

type Scalar = "int" | "number" | "string" | "boolean" | "uuid" | "timestamp";

const SCALARS: readonly string[] = ["int", "number", "string", "boolean", "uuid", "timestamp"];

/** Named formats, per the closed `FORMATS` table in the DSL document. */
const FORMATS: readonly string[] = ["sha256_16"];

export type PayloadType =
  | { readonly kind: "scalar"; readonly scalar: Scalar }
  /**
   * `string(a|b|c)` / `int(1|2|3)`. The alternatives are parsed and kept — the
   * ingest compiler needs them — but the client checks only `base`.
   */
  | {
      readonly kind: "enum";
      readonly base: "string" | "int";
      readonly alternatives: readonly string[];
    }
  /** `string(sha256_16)` — a hash, not an enum. See the DSL document's resolution rule. */
  | { readonly kind: "format"; readonly format: string }
  | { readonly kind: "array"; readonly items: Scalar }
  | { readonly kind: "map"; readonly keys: Scalar; readonly values: Scalar }
  | { readonly kind: "nullable"; readonly inner: PayloadType };

/** Why a value was refused. `null` means it was accepted. */
export type PayloadTypeError = "invalid_type" | "oversized_value";

const CACHE = new Map<string, PayloadType | null>();

/**
 * Parse one registry type hint. Returns null for anything the grammar does not
 * cover, and callers must treat null as "refuse", never as "allow" — a hint we
 * cannot read is exactly the case where we do not know what is in the value.
 */
export function parsePayloadType(hint: string): PayloadType | null {
  const cached = CACHE.get(hint);
  if (cached !== undefined) return cached;
  const parsed = parse(hint);
  CACHE.set(hint, parsed);
  return parsed;
}

function parse(hint: string): PayloadType | null {
  if (hint.endsWith("|null")) {
    const inner = parse(hint.slice(0, -"|null".length));
    // `T|null|null` and `string[]|null` are not productions of the grammar.
    if (!inner || inner.kind === "nullable" || inner.kind === "array" || inner.kind === "map") {
      return null;
    }
    return { kind: "nullable", inner };
  }

  if (hint.endsWith("[]")) {
    const items = hint.slice(0, -2);
    return isScalar(items) ? { kind: "array", items } : null;
  }

  const map = /^object<([a-z]+),\s*([a-z]+)>$/.exec(hint);
  if (map) {
    const [, keys, values] = map;
    return isScalar(keys) && isScalar(values) ? { kind: "map", keys, values } : null;
  }

  const parenthesised = /^([a-z]+)\(([^()]*)\)$/.exec(hint);
  if (parenthesised) {
    const [, base, body] = parenthesised;
    if (base !== "string" && base !== "int") return null;
    if (body.length === 0) return null;
    const alternatives = body.split("|");
    if (alternatives.some((alternative) => alternative.length === 0)) return null;
    if (base === "string" && alternatives.length === 1 && FORMATS.includes(alternatives[0])) {
      return { kind: "format", format: alternatives[0] };
    }
    return { kind: "enum", base, alternatives };
  }

  return isScalar(hint) ? { kind: "scalar", scalar: hint } : null;
}

function isScalar(value: string): value is Scalar {
  return SCALARS.includes(value);
}

/**
 * Check one payload value against its declared type, recursively.
 *
 * Returns `"oversized_value"` when something answer-shaped is found at any
 * depth — including inside a `string[]` and inside the keys of a map — and
 * `"invalid_type"` when the value is not the shape the registry promised, which
 * is the other way a blob of text reaches the pipe: a field declared `string`
 * holding `{ answer: "…" }` used to sail straight through.
 */
export function checkPayloadValue(type: PayloadType, value: unknown): PayloadTypeError | null {
  switch (type.kind) {
    case "nullable":
      return value === null ? null : checkPayloadValue(type.inner, value);

    case "scalar":
      return checkScalar(type.scalar, value);

    case "enum":
      return checkScalar(type.base === "int" ? "int" : "string", value);

    case "format":
      return checkScalar("string", value);

    case "array": {
      if (!Array.isArray(value)) return "invalid_type";
      if (value.length > MAX_PAYLOAD_COLLECTION_SIZE) return "oversized_value";
      for (const item of value) {
        const error = checkScalar(type.items, item);
        if (error) return error;
      }
      return null;
    }

    case "map": {
      if (!isPlainObject(value)) return "invalid_type";
      const entries = Object.entries(value);
      if (entries.length > MAX_PAYLOAD_COLLECTION_SIZE) return "oversized_value";
      for (const [key, entry] of entries) {
        const keyError = checkScalar(type.keys, key);
        if (keyError) return keyError;
        const valueError = checkScalar(type.values, entry);
        if (valueError) return valueError;
      }
      return null;
    }
  }
}

function checkScalar(scalar: Scalar, value: unknown): PayloadTypeError | null {
  switch (scalar) {
    case "int":
      return typeof value === "number" && Number.isInteger(value) ? null : "invalid_type";
    case "number":
      // NaN and Infinity serialise to `null`, which would arrive as a hole in
      // the column rather than as an error anybody sees.
      return typeof value === "number" && Number.isFinite(value) ? null : "invalid_type";
    case "boolean":
      return typeof value === "boolean" ? null : "invalid_type";
    case "string":
    case "uuid":
    case "timestamp":
      if (typeof value !== "string") return "invalid_type";
      return value.length > MAX_PAYLOAD_STRING_LENGTH ? "oversized_value" : null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
