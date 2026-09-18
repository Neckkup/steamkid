/**
 * Where validated events go.
 *
 * The gate (`ingest.ts`) and the store are separated because they land in
 * different tickets: PRO-22 hardens what is allowed to exist, PRO-7 builds
 * `events.behavior_event` (partitioned, append-only, de-duplicated on
 * `(learner_id, event_id)`) and `events.dead_letter` underneath it.
 *
 * Until the PRO-7 migration exists, `getEventSink()` returns null and
 * `POST /api/events` answers **503**. That is deliberate: a 202 from an
 * endpoint that drops the batch would be the worst outcome available here.
 * Behaviour events are unbackfillable — a client that is told "accepted"
 * discards its retry buffer, and the child's first session is gone for good.
 * A 503 keeps the events queued in the browser and keeps the gap visible.
 */

import type { EventEnvelope } from "./envelope";
import type { DeadLetterRecord } from "./ingest";

export interface EventSink {
  /** Must be idempotent on `(learner, event_id)`: child networks retry. */
  accept(events: readonly EventEnvelope[]): Promise<void>;
  deadLetter(records: readonly DeadLetterRecord[]): Promise<void>;
}

let installed: EventSink | null = null;

/** Wiring point for the Postgres sink (PRO-7) and for tests. */
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
 * without a Postgres instance.
 */
export class MemoryEventSink implements EventSink {
  readonly accepted: EventEnvelope[] = [];
  readonly deadLettered: DeadLetterRecord[] = [];

  async accept(events: readonly EventEnvelope[]): Promise<void> {
    this.accepted.push(...events);
  }

  async deadLetter(records: readonly DeadLetterRecord[]): Promise<void> {
    this.deadLettered.push(...records);
  }
}
