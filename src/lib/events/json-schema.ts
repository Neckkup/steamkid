/**
 * A validator for exactly the JSON Schema subset `payload-schema.ts` emits.
 *
 * Why not a library: the emitted subset is nine keywords wide and closed by the
 * DSL document, and the failure mode we are defending against is a keyword that
 * is quietly ignored — `maxLength` dropped inside `anyOf`, `format` treated as
 * an annotation — which is precisely the class of bug a general validator has
 * options for and we do not want options about. Every keyword below is
 * implemented; an unrecognised one throws rather than passing.
 *
 * Violations carry a **path and a keyword, never a value**. The values here are
 * the reason this file exists: one of them may be a child's essay, and it must
 * not travel into a log line, a metric label or a dead-letter row.
 */

import type { JsonSchema } from "./payload-schema";

export interface SchemaViolation {
  /** e.g. `payload.criteria_addressed[0]` */
  readonly path: string;
  /** The JSON Schema keyword that failed, e.g. `maxLength`. */
  readonly keyword: string;
}

/** RFC 3339 date-time, as `format: "date-time"` means it. */
const DATE_TIME =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

const KNOWN_KEYWORDS = new Set([
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
 * Collect every violation of `schema` by `value`.
 *
 * Returns all of them rather than the first, so a dead-letter row explains the
 * whole event instead of one field at a time across five retries.
 */
export function validateAgainstSchema(
  schema: JsonSchema,
  value: unknown,
  path = "payload",
): SchemaViolation[] {
  for (const keyword of Object.keys(schema)) {
    if (!KNOWN_KEYWORDS.has(keyword)) {
      throw new Error(`unsupported JSON Schema keyword in compiled schema: ${keyword}`);
    }
  }

  const violations: SchemaViolation[] = [];

  if (schema.anyOf) {
    const matched = schema.anyOf.some(
      (branch) => validateAgainstSchema(branch, value, path).length === 0,
    );
    if (!matched) violations.push({ path, keyword: "anyOf" });
    return violations;
  }

  if (schema.type && !matchesType(schema.type, value)) {
    return [{ path, keyword: "type" }];
  }

  if (typeof value === "string") {
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      violations.push({ path, keyword: "maxLength" });
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      violations.push({ path, keyword: "pattern" });
    }
    if (schema.format === "date-time" && !DATE_TIME.test(value)) {
      violations.push({ path, keyword: "format" });
    }
  }

  if (schema.enum && !schema.enum.includes(value as string | number)) {
    violations.push({ path, keyword: "enum" });
  }

  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      violations.push({ path, keyword: "maxItems" });
    }
    if (schema.items) {
      value.forEach((item, index) => {
        violations.push(...validateAgainstSchema(schema.items!, item, `${path}[${index}]`));
      });
    }
  }

  if (isPlainObject(value)) {
    const entries = Object.entries(value);

    if (schema.maxProperties !== undefined && entries.length > schema.maxProperties) {
      violations.push({ path, keyword: "maxProperties" });
    }

    for (const [key, entry] of entries) {
      const child = `${path}.${key}`;

      if (schema.propertyNames) {
        // The key itself is a value too. `{"<a 7,000 character essay>": 1}` is
        // a real shape and it is not smaller for being a key.
        violations.push(...validateAgainstSchema(schema.propertyNames, key, `${child} (key)`));
      }

      const declared = schema.properties?.[key];
      if (declared) {
        violations.push(...validateAgainstSchema(declared, entry, child));
        continue;
      }

      if (schema.additionalProperties === false) {
        violations.push({ path: child, keyword: "additionalProperties" });
        continue;
      }

      if (schema.additionalProperties) {
        violations.push(...validateAgainstSchema(schema.additionalProperties, entry, child));
      }
    }
  }

  return violations;
}

function matchesType(type: NonNullable<JsonSchema["type"]>, value: unknown): boolean {
  switch (type) {
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      // NaN and Infinity do not survive JSON, but a validator that accepted
      // them would let a hole into the column rather than an error.
      return typeof value === "number" && Number.isFinite(value);
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return isPlainObject(value);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
