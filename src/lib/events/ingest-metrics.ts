/**
 * Counters for the ingest gate.
 *
 * A rejected event that is only dead-lettered is a fact in a table nobody
 * queries. The number that matters is the rate: "0.2% of `session.heartbeat`
 * started failing validation this afternoon" is a deploy that broke the
 * emitter, and it should be visible without anyone opening `events.dead_letter`.
 *
 * In-process counters, deliberately. There is no metrics backend wired yet
 * (PRO-12 owns the accounts); `observeIngestMetric` is the seam a real exporter
 * plugs into, and until then `/api/events` logs one structured line per
 * rejection and the counters are readable in tests and from the health route.
 *
 * Labels are `reason` and `event_name` only — both come from a closed set.
 * Never a field value: the whole point of this pipeline is that a child's text
 * does not end up somewhere it cannot be deleted from, and a metric label is
 * exactly such a place.
 */

import type { RejectionReason } from "./ingest";

export interface IngestMetrics {
  readonly batches: number;
  readonly accepted: number;
  readonly rejected: number;
  /** rejection count by reason code. */
  readonly byReason: Readonly<Record<string, number>>;
  /** rejection count by event name (`"<unregistered>"` when the name is not ours). */
  readonly byEventName: Readonly<Record<string, number>>;
}

export interface IngestMetricEvent {
  readonly reason: RejectionReason;
  readonly eventName: string;
}

let batches = 0;
let accepted = 0;
let rejected = 0;
let byReason: Record<string, number> = {};
let byEventName: Record<string, number> = {};

const observers = new Set<(event: IngestMetricEvent) => void>();

/** Register an exporter. Returns the unsubscribe function. */
export function observeIngestMetric(observer: (event: IngestMetricEvent) => void): () => void {
  observers.add(observer);
  return () => observers.delete(observer);
}

export function countBatch(acceptedCount: number): void {
  batches += 1;
  accepted += acceptedCount;
}

export function countRejection(reason: RejectionReason, eventName: string | null): void {
  const name = eventName ?? "<unregistered>";
  rejected += 1;
  byReason[reason] = (byReason[reason] ?? 0) + 1;
  byEventName[name] = (byEventName[name] ?? 0) + 1;

  for (const observer of observers) {
    // An exporter that throws must not cost us the event we were writing.
    try {
      observer({ reason, eventName: name });
    } catch {
      // Intentionally ignored.
    }
  }
}

export function snapshotIngestMetrics(): IngestMetrics {
  return { batches, accepted, rejected, byReason: { ...byReason }, byEventName: { ...byEventName } };
}

/** Tests only. Counters are process-lifetime otherwise. */
export function resetIngestMetrics(): void {
  batches = 0;
  accepted = 0;
  rejected = 0;
  byReason = {};
  byEventName = {};
}
