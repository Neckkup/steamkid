/**
 * The behaviour tracker: the client half of the pipe PRO-3 specified and
 * Backend receives in PRO-7.
 *
 * Contract it implements (PRO-3 `behavior-events` + `data-schema`):
 *
 *   - batches of at most 50, flushed every 5 seconds, `POST /api/events`
 *   - at-least-once delivery; the server de-duplicates on `event_id`
 *   - ordering by `client_seq`, because a child's device clock can be wrong
 *   - nothing is emitted without the `behaviour_events` consent scope
 *   - unknown event names and undeclared payload keys never leave the browser
 *   - a declared key whose value is not the shape the registry promised never
 *     leaves either, at any depth (`payload-type.ts`)
 *
 * And one rule that is not in any document but is in the product: **a failure
 * in here must never be visible to a child**. No throw reaches a render, no
 * alert, no red screen. Events are valuable; a child's lesson is more so.
 */

import { ActivityClock } from "./activity";
import type { EventContext, EventEnvelope, RandomBytes } from "./envelope";
import { defaultRandomBytes, uuidv7 } from "./envelope";
import { checkPayloadValue, parsePayloadType } from "./payload-type";
import { CONSENT_EXEMPT_EVENTS, getEventDefinition, REGISTRY_VERSION } from "./registry";

/** Batch size cap from the PRO-3 ingest contract. */
export const MAX_BATCH_SIZE = 50;

/** Flush cadence from the PRO-3 ingest contract. */
export const FLUSH_INTERVAL_MS = 5_000;

/**
 * Upper bound on the queue when the network is down. Beyond this we drop the
 * oldest events: a child on a bad connection should not watch memory grow all
 * afternoon, and the newest events are the ones still worth having.
 */
export const MAX_QUEUE_SIZE = 500;

export type TrackerViolation =
  | { readonly kind: "unknown_event"; readonly eventName: string }
  | { readonly kind: "undeclared_field"; readonly eventName: string; readonly field: string }
  | { readonly kind: "oversized_value"; readonly eventName: string; readonly field: string }
  | { readonly kind: "invalid_type"; readonly eventName: string; readonly field: string }
  | { readonly kind: "queue_overflow"; readonly dropped: number }
  | { readonly kind: "transport_failed"; readonly batchSize: number };

export interface TrackerTransport {
  /** Resolves false (or rejects) when the batch should be retried. */
  send(batch: readonly EventEnvelope[]): Promise<boolean>;
}

export interface TrackerOptions {
  readonly sessionId: string;
  readonly transport: TrackerTransport;
  /** Whether the guardian has granted the `behaviour_events` scope. */
  readonly consentGranted: boolean;
  readonly now?: () => number;
  readonly randomBytes?: RandomBytes;
  readonly maxBatchSize?: number;
  readonly maxQueueSize?: number;
  /**
   * Called when the tracker refuses to emit something. In development this is
   * how a mistyped event name becomes visible immediately instead of becoming
   * a hole in the dataset. It never receives payload values — only field names.
   */
  readonly onViolation?: (violation: TrackerViolation) => void;
}

export class BehaviorTracker {
  private queue: EventEnvelope[] = [];
  private sending = false;
  private seq = 0;
  private consentGranted: boolean;
  private readonly now: () => number;
  private readonly randomBytes: RandomBytes;
  private readonly maxBatchSize: number;
  private readonly maxQueueSize: number;

  constructor(private readonly options: TrackerOptions) {
    this.consentGranted = options.consentGranted;
    this.now = options.now ?? (() => Date.now());
    this.randomBytes = options.randomBytes ?? defaultRandomBytes;
    this.maxBatchSize = options.maxBatchSize ?? MAX_BATCH_SIZE;
    this.maxQueueSize = options.maxQueueSize ?? MAX_QUEUE_SIZE;
  }

  /**
   * Queue one event. Returns whether it was accepted, which callers are free
   * to ignore — the return value is for tests, not for the UI.
   */
  track(
    eventName: string,
    payload: Readonly<Record<string, unknown>> = {},
    context: EventContext = {},
  ): boolean {
    const definition = getEventDefinition(eventName);
    if (!definition) {
      this.report({ kind: "unknown_event", eventName });
      return false;
    }

    if (!this.consentGranted && !CONSENT_EXEMPT_EVENTS.includes(eventName)) {
      return false;
    }

    for (const [field, value] of Object.entries(payload)) {
      if (!(field in definition.payload)) {
        this.report({ kind: "undeclared_field", eventName, field });
        return false;
      }
      // An omitted field and an explicitly-undefined one are the same event
      // once it is serialised, so treat them the same here.
      if (value === undefined) continue;

      // Checked against the type the registry declares, at every depth. A
      // top-level `typeof value === "string"` test — which is what this used to
      // be — sees nothing inside `criteria_addressed: [essay]` (PRO-21).
      const declared = parsePayloadType(definition.payload[field]);
      if (!declared) {
        // A type hint this build cannot read. Refuse: not knowing the shape is
        // precisely the case where a child's text could be in it. The unit test
        // over all 39 events is what stops this reaching a child's browser.
        this.report({ kind: "invalid_type", eventName, field });
        return false;
      }
      const error = checkPayloadValue(declared, value);
      if (error) {
        this.report({ kind: error, eventName, field });
        return false;
      }
    }

    const at = this.now();
    this.enqueue({
      event_id: uuidv7(at, this.randomBytes),
      client_seq: ++this.seq,
      event_name: definition.name,
      event_version: definition.version,
      occurred_at: new Date(at).toISOString(),
      session_id: this.options.sessionId,
      registry_version: REGISTRY_VERSION,
      lesson_id: context.lesson_id ?? null,
      item_id: context.item_id ?? null,
      submission_id: context.submission_id ?? null,
      path_step_id: context.path_step_id ?? null,
      verdict_id: context.verdict_id ?? null,
      correlation_id: context.correlation_id ?? null,
      payload,
    });

    return true;
  }

  /**
   * Consent can be withdrawn mid-session. From that moment nothing new is
   * queued, and anything still queued is dropped rather than delivered late.
   */
  setConsent(granted: boolean): void {
    this.consentGranted = granted;
    if (!granted) {
      this.queue = this.queue.filter((event) => CONSENT_EXEMPT_EVENTS.includes(event.event_name));
    }
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  /** Everything still queued, oldest first. For the page-unload beacon. */
  drain(): EventEnvelope[] {
    const pending = this.queue;
    this.queue = [];
    return pending;
  }

  /**
   * Send one batch. Failed batches go back to the front of the queue so
   * ordering survives a retry; the server de-duplicates whatever arrives twice.
   */
  async flush(): Promise<void> {
    if (this.sending || this.queue.length === 0) return;

    this.sending = true;
    const batch = this.queue.slice(0, this.maxBatchSize);
    this.queue = this.queue.slice(batch.length);

    try {
      const delivered = await this.options.transport.send(batch);
      if (!delivered) this.requeue(batch);
    } catch {
      // Never surfaced to the child. The retry is the whole response.
      this.requeue(batch);
      this.report({ kind: "transport_failed", batchSize: batch.length });
    } finally {
      this.sending = false;
    }
  }

  private enqueue(event: EventEnvelope): void {
    this.queue.push(event);
    this.trim();
    if (this.queue.length >= this.maxBatchSize) {
      void this.flush();
    }
  }

  private requeue(batch: readonly EventEnvelope[]): void {
    this.queue = [...batch, ...this.queue];
    this.trim();
  }

  private trim(): void {
    const overflow = this.queue.length - this.maxQueueSize;
    if (overflow <= 0) return;
    this.queue = this.queue.slice(overflow);
    this.report({ kind: "queue_overflow", dropped: overflow });
  }

  private report(violation: TrackerViolation): void {
    this.options.onViolation?.(violation);
  }
}

/**
 * Drives `session.heartbeat` off the activity clock.
 *
 * Returns the payload to emit, or null when the child is not actually there —
 * which is the entire point of the heartbeat. A heartbeat emitted on a timer
 * alone would make "left the tab open" indistinguishable from "read carefully".
 */
export function nextHeartbeat(
  clock: ActivityClock,
  now: number,
): { readonly active_ms_delta: number } | null {
  if (!clock.isActive(now)) return null;
  const delta = clock.takeActiveDelta(now);
  if (delta <= 0) return null;
  return { active_ms_delta: delta };
}
