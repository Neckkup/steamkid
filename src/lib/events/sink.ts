/**
 * Where validated events go.
 *
 * The gate (`ingest.ts`) and the store are separated because they answer
 * different questions: the gate decides what is allowed to exist, the sink
 * decides where it lands and whether consent permits it to land at all.
 *
 * `PostgresEventSink` (`pg-sink.ts`) is the real one. When no sink is
 * installed, `POST /api/events` answers **503**. That is deliberate: a 202 from
 * an endpoint that drops the batch would be the worst outcome available here.
 * Behaviour events are unbackfillable — a client that is told "accepted"
 * discards its retry buffer, and the child's first session is gone for good. A
 * 503 keeps the events queued in the browser and keeps the gap visible.
 */

import type { EventEnvelope } from "./envelope";
import type { DeadLetterRecord } from "./ingest";

/**
 * Who this batch belongs to, decided by the server.
 *
 * `learnerId` is `app.learner.id` and is resolved from the session cookie, not
 * read from the request body — a client that could name the learner could also
 * name a different one (data-schema rule 1).
 */
export interface IngestContext {
  readonly learnerId: string;
  /** Server clock for this request, ISO 8601. */
  readonly receivedAt: string;
}

export interface EventSink {
  /** Must be idempotent on `(learner, event_id)`: child networks retry. */
  accept(context: IngestContext, events: readonly EventEnvelope[]): Promise<void>;
  deadLetter(context: IngestContext, records: readonly DeadLetterRecord[]): Promise<void>;
}

let installed: EventSink | null = null;

/** Wiring point for the Postgres sink and for tests. */
export function setEventSink(sink: EventSink | null): void {
  installed = sink;
}

export function getEventSink(): EventSink | null {
  return installed;
}

/**
 * In-memory sink for tests and for a local checkout without a database.
 *
 * Also the fixture QA can drive the endpoint against: it holds exactly what a
 * real sink would have been handed, so "was this rejected" is answerable
 * without a Postgres instance. It does **not** model consent or de-duplication
 * — those are properties of the real sink and are tested against a real
 * database in `pg-sink.test.ts`.
 */
export class MemoryEventSink implements EventSink {
  readonly accepted: EventEnvelope[] = [];
  readonly deadLettered: DeadLetterRecord[] = [];

  async accept(_context: IngestContext, events: readonly EventEnvelope[]): Promise<void> {
    this.accepted.push(...events);
  }

  async deadLetter(
    _context: IngestContext,
    records: readonly DeadLetterRecord[],
  ): Promise<void> {
    this.deadLettered.push(...records);
  }
}
