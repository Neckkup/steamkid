/**
 * The registry payload DSL, compiled to JSON Schema.
 *
 * `docs/event-payload-dsl.md` is the normative grammar (PRO-17 decision 3:
 * `event-registry.v1.json` stays the single source of truth, a build step
 * compiles its short type hints into the JSON Schema that
 * `events.event_registry.payload_schema` stores). This module is that build
 * step, and the same schemas are what `POST /api/events` validates against, so
 * the column and the gate can never drift apart.
 *
 * Parsing is not repeated here: `payload-type.ts` already reads this grammar
 * for the client-side guard, and two parsers of one grammar is two chances to
 * read it differently. One parser, two back-ends — a structural check in the
 * browser, a full value-domain schema at ingest.
 *
 * Two rules from the document that are enforced as **build** failures, never
 * ingest failures:
 *
 *   - a type hint the grammar does not cover throws. It must never degrade to
 *     `{}`, which validates everything, which is how unvalidated child-typed
 *     text would reach an append-only table.
 *   - a name in `FORMATS` must not also be a legal enum alternative anywhere in
 *     the registry, or the two resolution rules for `string(X)` disagree.
 */

import { parsePayloadType, type PayloadType, MAX_PAYLOAD_COLLECTION_SIZE } from "./payload-type";
import { getEventDefinition, type EventDefinition, MAX_PAYLOAD_STRING_LENGTH } from "./registry";
import registryFile from "./event-registry.v1.json";

/**
 * The closed subset of JSON Schema this compiler emits and
 * `validateAgainstSchema` understands. Narrow on purpose: every keyword here is
 * one we implement, so there is no keyword that is silently ignored at ingest.
 */
export interface JsonSchema {
  readonly type?: "integer" | "number" | "string" | "boolean" | "null" | "array" | "object";
  readonly enum?: readonly (string | number)[];
  readonly pattern?: string;
  readonly format?: string;
  readonly maxLength?: number;
  readonly items?: JsonSchema;
  readonly maxItems?: number;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly additionalProperties?: JsonSchema | false;
  readonly propertyNames?: JsonSchema;
  readonly maxProperties?: number;
  readonly anyOf?: readonly JsonSchema[];
}

/** Thrown at build/seed time. Never thrown while serving a request. */
export class PayloadSchemaError extends Error {}

/**
 * `pattern` as well as `format`, because `format` is annotation-only in most
 * validators and these ids are join keys (DSL document, scalars table).
 */
export const UUID_PATTERN =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

/**
 * The closed `FORMATS` table. `sha256_16` accepts the empty string on purpose:
 * `answerHash("")` returns `""` so that "not started" stays distinguishable
 * from "wrote something", and a pattern without the optional group would reject
 * the first `item.answer_changed` of every exercise.
 */
const FORMAT_SCHEMAS: Readonly<Record<string, JsonSchema>> = {
  sha256_16: { type: "string", pattern: "^([0-9a-f]{16})?$" },
};

export const FORMAT_NAMES: readonly string[] = Object.keys(FORMAT_SCHEMAS);

function scalarSchema(scalar: string): JsonSchema {
  switch (scalar) {
    case "int":
      return { type: "integer" };
    case "number":
      // Not `integer`: days_since_last_open and watched_ratio are genuinely
      // fractional.
      return { type: "number" };
    case "string":
      // maxLength mirrors MAX_PAYLOAD_STRING_LENGTH. The client already refuses
      // to send longer; the server must not be more permissive than the client.
      return { type: "string", maxLength: MAX_PAYLOAD_STRING_LENGTH };
    case "boolean":
      return { type: "boolean" };
    case "uuid":
      return { type: "string", format: "uuid", pattern: UUID_PATTERN };
    case "timestamp":
      // The raw child clock. Validated as a date-time *syntactically* only —
      // implausible skew is the entire point of the field (data-schema §4.1),
      // so a clock two years fast is data, not an error.
      return { type: "string", format: "date-time", maxLength: MAX_PAYLOAD_STRING_LENGTH };
    default:
      throw new PayloadSchemaError(`unknown scalar in payload DSL: ${scalar}`);
  }
}

function fromParsed(type: PayloadType): JsonSchema {
  switch (type.kind) {
    case "scalar":
      return scalarSchema(type.scalar);

    case "enum":
      return type.base === "int"
        ? // Integer alternatives are parsed as numbers. enum:["25","50"] would
          // reject every real lesson.scroll_depth event.
          { type: "integer", enum: type.alternatives.map(toIntegerAlternative) }
        : { type: "string", enum: [...type.alternatives] };

    case "format": {
      const schema = FORMAT_SCHEMAS[type.format];
      if (!schema) throw new PayloadSchemaError(`unknown format name: ${type.format}`);
      return schema;
    }

    case "array":
      // maxItems is an addition to the DSL document, mirroring the client cap
      // Coder added in PRO-21: without it the 200-character guard is defeated
      // by chunking one essay into individually legal slices.
      return { type: "array", items: scalarSchema(type.items), maxItems: MAX_PAYLOAD_COLLECTION_SIZE };

    case "map":
      // additionalProperties, not enumerated properties: the keys are skill
      // codes and the skill map grows.
      return {
        type: "object",
        additionalProperties: scalarSchema(type.values),
        propertyNames: scalarSchema(type.keys),
        maxProperties: MAX_PAYLOAD_COLLECTION_SIZE,
      };

    case "nullable":
      // anyOf, never {"type":["string","null"]}: the type-array form silently
      // drops `pattern` and `enum` for the null branch in several validators.
      return { anyOf: [fromParsed(type.inner), { type: "null" }] };
  }
}

function toIntegerAlternative(alternative: string): number {
  const value = Number(alternative);
  if (!Number.isInteger(value)) {
    throw new PayloadSchemaError(`int enum alternative is not an integer: ${alternative}`);
  }
  return value;
}

/** Compile one registry type hint, e.g. `"uuid|null"`. Throws on anything else. */
export function compileTypeHint(hint: string): JsonSchema {
  const parsed = parsePayloadType(hint);
  if (!parsed) {
    throw new PayloadSchemaError(
      `unrecognised payload type hint: ${hint}. Add the production to ` +
        `docs/event-payload-dsl.md and payload-type.ts rather than widening the schema.`,
    );
  }
  return fromParsed(parsed);
}

/**
 * The payload schema for one event.
 *
 * `additionalProperties: false` is the rule that stops a child's typed answer
 * riding along in a key nobody declared.
 *
 * Declared fields are **not** required. The emitter legitimately sends partial
 * payloads today (`nextHeartbeat` returns `active_ms_delta` alone), and a
 * missing field is a reporting gap we can see in a query, while a rejected
 * event is a signal we can never recover. Absence is cheap; leakage is not.
 */
export function compileEventPayloadSchema(definition: EventDefinition): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  for (const [field, hint] of Object.entries(definition.payload)) {
    try {
      properties[field] = compileTypeHint(hint);
    } catch (cause) {
      throw new PayloadSchemaError(
        `${definition.name}.${field}: ${(cause as Error).message}`,
      );
    }
  }
  return { type: "object", properties, additionalProperties: false };
}

const COMPILED = new Map<string, JsonSchema>();

/** Compiled schema for a registered event name, memoised. */
export function getPayloadSchema(eventName: string): JsonSchema | undefined {
  const cached = COMPILED.get(eventName);
  if (cached) return cached;

  const definition = getEventDefinition(eventName);
  if (!definition) return undefined;

  const schema = compileEventPayloadSchema(definition);
  COMPILED.set(eventName, schema);
  return schema;
}

/** Every event in the registry, compiled. This is what seeds `events.event_registry`. */
export function compileRegistry(): Map<string, JsonSchema> {
  const compiled = new Map<string, JsonSchema>();
  for (const definition of (registryFile as unknown as { events: EventDefinition[] }).events) {
    compiled.set(definition.name, compileEventPayloadSchema(definition));
  }
  return compiled;
}

/**
 * Build-time invariant: no `FORMATS` name is also a legal enum alternative.
 *
 * If that ever became true, `string(X)` would resolve to a format under rule 1
 * and to an enum under rule 2, and the disagreement would surface as
 * dead-lettered events rather than as an error anybody reads.
 */
export function assertRegistryInvariants(): void {
  const alternatives = new Set<string>();

  for (const definition of (registryFile as unknown as { events: EventDefinition[] }).events) {
    for (const [field, hint] of Object.entries(definition.payload)) {
      const parsed = parsePayloadType(hint);
      if (!parsed) {
        throw new PayloadSchemaError(
          `${definition.name}.${field}: unrecognised payload type hint: ${hint}`,
        );
      }
      if (parsed.kind === "enum") {
        for (const alternative of parsed.alternatives) alternatives.add(alternative);
      }
    }
  }

  for (const name of FORMAT_NAMES) {
    if (alternatives.has(name)) {
      throw new PayloadSchemaError(
        `format name "${name}" is also an enum alternative in the registry; ` +
          `the two resolution rules for string(X) now disagree`,
      );
    }
  }
}
