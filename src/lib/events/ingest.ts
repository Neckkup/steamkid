/**
 * The ingest gate for `POST /api/events` (PRO-7, hardened by PRO-22).
 *
 * The registry file says it itself: "Backend owns ingestion validation". A
 * client-side guard is a courtesy — the version of the app sitting in a child's
 * browser tab today is not the version we shipped this morning, and a tab can
 * stay open for weeks. Whatever the emitter does or fails to do, this is the
 * boundary that decides what becomes a permanent row.
 *
 * Four checks, in this order, per event:
 *
 *   1. envelope shape — strict; an undeclared top-level key is refused for the
 *      same reason an undeclared payload key is
 *   2. registry lookup — `event_name` + `event_version` is the contract
 *   3. `scanPayload` — no long string anywhere, at any depth, in a key or a
 *      value, regardless of what the registry declares for that field
 *   4. the compiled JSON Schema — undeclared keys, types, enums, patterns
 *
 * Step 3 before step 4 on purpose: both reject a child's essay in
 * `criteria_addressed`, but only step 3 names it as what it is, and the metric
 * label is what somebody reads at 2am.
 *
 * Nothing that fails is written to `events.behavior_event`. It goes to
 * `events.dead_letter` **shape-described, never verbatim** — quarantining the
 * essay in another append-only table would move the leak, not close it.
 */

import { z } from "zod";

import { uuidv7Timestamp } from "@/lib/ids";

import type { EventEnvelope } from "./envelope";
import { validateAgainstSchema, type SchemaViolation } from "./json-schema";
import { countBatch, countRejection } from "./ingest-metrics";
import { describePayload, MAX_PAYLOAD_BYTES, payloadByteLength, scanPayload } from "./payload-guard";
import { getPayloadSchema, UUID_PATTERN } from "./payload-schema";
import { getEventDefinition, REGISTRY_VERSION } from "./registry";

/**
 * Largest batch the endpoint accepts, from the PRO-3 ingest contract.
 *
 * Stated here rather than imported from `tracker.ts`: the server's limit must
 * not be whatever the current client happens to use, and the client module is
 * browser-side. `ingest.test.ts` asserts the two numbers still agree.
 */
export const MAX_BATCH_SIZE = 50;

/**
 * How far in the past an `event_time` may sit and still be believable.
 *
 * Seven days because the tracker's retry buffer lives in memory and dies with
 * the tab (`tracker.ts`), so nothing legitimate can be older than a device that
 * was suspended over a long weekend. Anything beyond it is a broken clock or a
 * replay, and either way it does not belong in a partition we pre-created.
 */
export const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60_000;

/** How far ahead of the server clock an `event_time` may sit. */
export const MAX_EVENT_SKEW_AHEAD_MS = 24 * 60 * 60_000;

/** Why an event was refused. Closed set: these are metric labels and DB values. */
export type RejectionReason =
  | "malformed_envelope"
  | "unknown_event"
  | "event_version_mismatch"
  | "invalid_event_id"
  | "implausible_event_time"
  | "payload_too_large"
  | "payload_too_deep"
  | "oversized_string"
  | "oversized_collection"
  | "undeclared_payload_key"
  | "payload_type_mismatch";

/** Why a whole request was refused before any event was looked at. */
export type BatchRejectionReason = "invalid_json" | "malformed_batch" | "batch_too_large";

/**
 * One quarantined event. Mirrors the `events.dead_letter` row PRO-7 creates.
 *
 * `payload_shape` and `detail` carry field names, types and lengths. No value
 * from the payload appears in either, by construction.
 */
export interface DeadLetterRecord {
  readonly event_id: string | null;
  readonly session_id: string | null;
  readonly event_name: string | null;
  readonly event_version: number | null;
  readonly registry_version: string | null;
  readonly occurred_at: string | null;
  readonly received_at: string;
  readonly reason: RejectionReason;
  readonly detail: readonly string[];
  readonly payload_shape: Readonly<Record<string, string>>;
}

export interface IngestResult {
  readonly accepted: readonly EventEnvelope[];
  readonly rejected: readonly DeadLetterRecord[];
}

export class BatchRejectedError extends Error {
  constructor(readonly reason: BatchRejectionReason) {
    super(reason);
  }
}

const uuid = z.string().regex(new RegExp(UUID_PATTERN));
const nullableUuid = uuid.nullable().optional();

/**
 * `strictObject`: an unknown top-level key is refused, not stripped. Stripping
 * would make a mistyped `sesion_id` look like a delivered event.
 *
 * `occurred_at` is the child's clock and is only checked for *syntax* — skew is
 * data we want, not an error (data-schema §4.1). The server records its own
 * `received_at` next to it.
 */
const envelopeSchema = z.strictObject({
  event_id: uuid,
  client_seq: z.number().int().min(0),
  event_name: z.string().min(1).max(120),
  event_version: z.number().int().min(1),
  occurred_at: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/),
  session_id: uuid,
  /**
   * Recorded, never enforced. Refusing an old `registry_version` would empty
   * the pipe of exactly the clients this gate exists for — the ones we cannot
   * redeploy.
   */
  registry_version: z.string().min(1).max(40),
  lesson_id: nullableUuid,
  item_id: nullableUuid,
  submission_id: nullableUuid,
  path_step_id: nullableUuid,
  verdict_id: nullableUuid,
  correlation_id: nullableUuid,
  payload: z.record(z.string(), z.unknown()),
});

/**
 * Pull a batch out of a parsed request body.
 *
 * Accepts `{"events": [...]}` and a bare array: `docs/frontend-spec.md` guessed
 * an array, the tracker's transport is Coder's to write, and refusing one of
 * the two shapes at runtime would cost real events to settle a style question.
 */
export function readBatch(body: unknown): unknown[] {
  const events = Array.isArray(body)
    ? body
    : typeof body === "object" && body !== null && Array.isArray((body as { events?: unknown }).events)
      ? ((body as { events: unknown[] }).events)
      : null;

  if (!events) throw new BatchRejectedError("malformed_batch");
  if (events.length > MAX_BATCH_SIZE) throw new BatchRejectedError("batch_too_large");
  return events;
}

/**
 * Validate one event.
 *
 * Returns the envelope to persist, or the dead-letter row to quarantine. It
 * never throws on bad input: a malformed event is an expected condition here,
 * not an exception.
 */
export function validateEvent(raw: unknown, receivedAt: string):
  | { readonly ok: true; readonly event: EventEnvelope }
  | { readonly ok: false; readonly record: DeadLetterRecord } {
  const parsed = envelopeSchema.safeParse(raw);
  if (!parsed.success) {
    const partial = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    return {
      ok: false,
      record: {
        ...identify(partial),
        received_at: receivedAt,
        reason: "malformed_envelope",
        // Issue paths only. zod messages can quote the offending value.
        detail: parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.code}`),
        payload_shape: describePayload(partial.payload),
      },
    };
  }

  const envelope = parsed.data as EventEnvelope;
  const reject = (reason: RejectionReason, detail: readonly string[]): {
    readonly ok: false;
    readonly record: DeadLetterRecord;
  } => ({
    ok: false,
    record: {
      event_id: envelope.event_id,
      session_id: envelope.session_id,
      event_name: envelope.event_name,
      event_version: envelope.event_version,
      registry_version: envelope.registry_version,
      occurred_at: envelope.occurred_at,
      received_at: receivedAt,
      reason,
      detail,
      payload_shape: describePayload(envelope.payload),
    },
  });

  /**
   * `event_time` is the UUIDv7 timestamp inside `event_id`, not anything the
   * client stamped (data-schema §4.1). It is the partition key and part of the
   * primary key, so both of these are structural, not hygiene:
   *
   *   - a v4 id carries no timestamp, so there is no partition to put it in
   *   - a timestamp outside the pre-created range has no partition either, and
   *     there is deliberately no DEFAULT partition to catch it
   *
   * Refusing here means the insert can never fail on a missing partition.
   */
  const eventTimeMs = uuidv7Timestamp(envelope.event_id);
  if (eventTimeMs === null) {
    return reject("invalid_event_id", ["event_id is not a UUIDv7"]);
  }

  const receivedAtMs = Date.parse(receivedAt);
  if (Number.isFinite(receivedAtMs)) {
    const ageMs = receivedAtMs - eventTimeMs;
    if (ageMs > MAX_EVENT_AGE_MS || ageMs < -MAX_EVENT_SKEW_AHEAD_MS) {
      return reject("implausible_event_time", [
        `event_time is ${Math.round(ageMs / 60_000)} minutes behind received_at`,
      ]);
    }
  }

  const definition = getEventDefinition(envelope.event_name);
  if (!definition) {
    return reject("unknown_event", [envelope.event_name]);
  }
  if (definition.version !== envelope.event_version) {
    return reject("event_version_mismatch", [
      `expected v${definition.version}, got v${envelope.event_version}`,
    ]);
  }

  const bytes = payloadByteLength(envelope.payload);
  if (bytes === null || bytes > MAX_PAYLOAD_BYTES) {
    return reject("payload_too_large", [`${bytes ?? "unserialisable"} bytes`]);
  }

  const guardViolations = scanPayload(envelope.payload);
  if (guardViolations.length > 0) {
    const worst = guardViolations[0]!;
    const reason: RejectionReason =
      worst.kind === "oversized_string"
        ? "oversized_string"
        : worst.kind === "oversized_collection"
          ? "oversized_collection"
          : "payload_too_deep";
    return reject(
      reason,
      guardViolations.map((violation) =>
        violation.kind === "oversized_string"
          ? `${violation.path}: string of ${violation.length} chars`
          : violation.kind === "oversized_collection"
            ? `${violation.path}: ${violation.size} entries`
            : `${violation.path}: ${violation.kind}`,
      ),
    );
  }

  const schema = getPayloadSchema(envelope.event_name)!;
  const schemaViolations = validateAgainstSchema(schema, envelope.payload);
  if (schemaViolations.length > 0) {
    const undeclared = schemaViolations.some(
      (violation) => violation.keyword === "additionalProperties",
    );
    return reject(
      undeclared ? "undeclared_payload_key" : "payload_type_mismatch",
      schemaViolations.map(describeViolation),
    );
  }

  return { ok: true, event: envelope };
}

/**
 * Validate a whole batch and count it.
 *
 * Persisting is the caller's job: this module decides what is allowed to exist,
 * and `POST /api/events` decides where it goes.
 */
export function validateBatch(events: readonly unknown[], receivedAt: string): IngestResult {
  const accepted: EventEnvelope[] = [];
  const rejected: DeadLetterRecord[] = [];

  for (const raw of events) {
    const result = validateEvent(raw, receivedAt);
    if (result.ok) {
      accepted.push(result.event);
    } else {
      rejected.push(result.record);
      countRejection(result.record.reason, result.record.event_name);
    }
  }

  countBatch(accepted.length);
  return { accepted, rejected };
}

/** True when the client is emitting against a registry version we no longer ship. */
export function isStaleRegistryVersion(envelope: EventEnvelope): boolean {
  return envelope.registry_version !== REGISTRY_VERSION;
}

function describeViolation(violation: SchemaViolation): string {
  return `${violation.path}: ${violation.keyword}`;
}

function identify(partial: Record<string, unknown>): Omit<
  DeadLetterRecord,
  "received_at" | "reason" | "detail" | "payload_shape"
> {
  const str = (value: unknown): string | null =>
    typeof value === "string" && value.length <= 120 ? value : null;
  const int = (value: unknown): number | null =>
    typeof value === "number" && Number.isInteger(value) ? value : null;

  return {
    event_id: str(partial.event_id),
    session_id: str(partial.session_id),
    event_name: str(partial.event_name),
    event_version: int(partial.event_version),
    registry_version: str(partial.registry_version),
    occurred_at: str(partial.occurred_at),
  };
}
