/**
 * The Postgres end of the behaviour pipe (PRO-7).
 *
 * `ingest.ts` decides what is allowed to exist. This decides where it goes, and
 * enforces the two rules that cannot live in the gate because they need the
 * learner behind the session cookie:
 *
 *   1. **Consent is a write-time constraint.** An event whose registry entry
 *      requires a scope the guardian has not granted is not written. Not
 *      written and filtered later, not written with a flag — never stored. The
 *      client still gets its 202, because telling it *why* would leak one
 *      child's consent state to whoever has the tab open.
 *   2. **A duplicate delivery is a no-op.** Child devices lose connections
 *      mid-flush and the tracker retries, so the same `event_id` arrives twice
 *      as a matter of routine. `ON CONFLICT DO NOTHING` on
 *      `(learner_id, event_id, event_time)` closes it in one statement, with no
 *      SELECT beforehand and therefore no window between the check and the
 *      write. That works only because `event_time` is a pure function of
 *      `event_id` — a CHECK constraint in migration 2 keeps it that way, so a
 *      retry that restamps its clock still lands on the same key.
 *
 * What is deliberately *not* here: any path that updates or deletes a stored
 * event. `events.behavior_event` carries a trigger that refuses both.
 */

import { uuidv7, uuidv7Timestamp } from "@/lib/ids";
import type { SqlExecutor } from "@/lib/db/sql";

import type { EventEnvelope } from "./envelope";
import type { DeadLetterRecord } from "./ingest";
import type { EventSink, IngestContext } from "./sink";
import { getEventDefinition } from "./registry";
import { isScorableSession, reconstructSession } from "./session-window";

/** Scope an event needs before it may be stored, per the registry. */
const DEFAULT_CONSENT_SCOPE = "behaviour_events";

export interface AcceptOutcome {
  /** Events that became new rows. */
  readonly inserted: number;
  /** Events that were already stored — a retry landing, working as designed. */
  readonly duplicate: number;
  /** Events dropped because the required consent scope was not granted. */
  readonly withheld: number;
}

export class PostgresEventSink implements EventSink {
  constructor(private readonly sql: SqlExecutor) {}

  async accept(context: IngestContext, events: readonly EventEnvelope[]): Promise<void> {
    await this.acceptWithOutcome(context, events);
  }

  /**
   * As `accept`, but reports what happened. The endpoint does not use the
   * numbers — it must not tell the client which of its events were withheld —
   * but tests and the ingest metrics do.
   */
  async acceptWithOutcome(
    context: IngestContext,
    events: readonly EventEnvelope[],
  ): Promise<AcceptOutcome> {
    if (events.length === 0) return { inserted: 0, duplicate: 0, withheld: 0 };

    const granted = await this.grantedScopes(context.learnerId);

    const writable: { envelope: EventEnvelope; scope: string }[] = [];
    let withheld = 0;
    for (const envelope of events) {
      const scope = requiredScope(envelope.event_name);
      if (granted.has(scope)) {
        writable.push({ envelope, scope });
      } else {
        withheld += 1;
      }
    }

    if (writable.length === 0) return { inserted: 0, duplicate: 0, withheld };

    await this.ensureSessions(context.learnerId, writable.map((entry) => entry.envelope));

    const columns = 18;
    const params: unknown[] = [];
    const tuples = writable.map(({ envelope, scope }, index) => {
      const base = index * columns;
      const eventTimeMs = uuidv7Timestamp(envelope.event_id);
      // Unreachable: `validateEvent` dead-letters a non-v7 id as
      // `invalid_event_id` before anything reaches the sink.
      if (eventTimeMs === null) throw new Error("event_id is not a UUIDv7");

      params.push(
        envelope.event_id,
        context.learnerId,
        envelope.session_id,
        new Date(eventTimeMs).toISOString(),
        envelope.occurred_at,
        context.receivedAt,
        envelope.client_seq,
        envelope.event_name,
        envelope.event_version,
        envelope.lesson_id ?? null,
        envelope.item_id ?? null,
        envelope.submission_id ?? null,
        envelope.path_step_id ?? null,
        envelope.verdict_id ?? null,
        JSON.stringify(envelope.payload),
        envelope.correlation_id ?? null,
        scope,
        envelope.registry_version,
      );

      return (
        `($${base + 1}::uuid, $${base + 2}::uuid, $${base + 3}::uuid, $${base + 4}::timestamptz, ` +
        `$${base + 5}::timestamptz, $${base + 6}::timestamptz, $${base + 7}::bigint, $${base + 8}::text, ` +
        `$${base + 9}::int, $${base + 10}::uuid, $${base + 11}::uuid, $${base + 12}::uuid, ` +
        `$${base + 13}::uuid, $${base + 14}::uuid, $${base + 15}::jsonb, $${base + 16}::uuid, ` +
        `$${base + 17}::text, $${base + 18}::text)`
      );
    });

    const { rows } = await this.sql.query<{ event_id: string }>(
      `INSERT INTO events.behavior_event (
         event_id, learner_id, session_id, event_time, occurred_at, received_at,
         client_seq, event_name, event_version, lesson_id, item_id, submission_id,
         path_step_id, verdict_id, payload, correlation_id, consent_scope_at_write,
         registry_version
       ) VALUES ${tuples.join(", ")}
       ON CONFLICT (learner_id, event_id, event_time) DO NOTHING
       RETURNING event_id`,
      params,
    );

    const outcome = {
      inserted: rows.length,
      duplicate: writable.length - rows.length,
      withheld,
    };

    // Reconcile every session that received at least one new event. This updates
    // events.session with server-computed active_ms, scorable, etc. — the values
    // ml.v_behaviour_sequences filters on. Duplicates (rows.length === 0) do not
    // need reconciliation because nothing changed.
    if (rows.length > 0) {
      const insertedIds = new Set(rows.map((r) => r.event_id));
      const affectedSessionIds = new Set(
        writable
          .filter(({ envelope }) => insertedIds.has(envelope.event_id))
          .map(({ envelope }) => envelope.session_id),
      );
      await Promise.all([...affectedSessionIds].map((id) => this.reconcileSession(id)));
    }

    return outcome;
  }

  /**
   * Quarantine refused events.
   *
   * Not gated on consent, and that is the right way round: a dead letter holds
   * field names, types and lengths — never a value — and losing it would hide
   * a broken emitter for exactly the children whose data we are most careful
   * with. `learner_id` is recorded so a guardian's erasure request can reach
   * these rows too.
   */
  async deadLetter(
    context: IngestContext,
    records: readonly DeadLetterRecord[],
  ): Promise<void> {
    for (const record of records) {
      await this.sql.query(
        `INSERT INTO events.dead_letter (
           id, learner_id, session_id, event_id, event_name, event_version,
           registry_version, occurred_at, received_at, reason, detail, payload_shape
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8::timestamptz,
                   $9::timestamptz, $10, $11::text[], $12::jsonb)`,
        [
          uuidv7(),
          context.learnerId,
          asUuid(record.session_id),
          asUuid(record.event_id),
          record.event_name,
          record.event_version,
          record.registry_version,
          record.occurred_at,
          record.received_at,
          record.reason,
          record.detail,
          JSON.stringify(record.payload_shape),
        ],
      );
    }
  }

  /** Currently granted scopes, read through the one sanctioned view. */
  private async grantedScopes(learnerId: string): Promise<Set<string>> {
    const { rows } = await this.sql.query<{ scope: string }>(
      `SELECT scope FROM app.consent_current WHERE learner_id = $1::uuid AND granted`,
      [learnerId],
    );
    return new Set(rows.map((row) => row.scope));
  }

  /**
   * Recompute one session's aggregate columns from its stored events.
   *
   * `events.session` is a computed summary, not history. This may be called any
   * number of times for the same session — the result converges, so a retry is
   * a no-op. Called automatically after each successful insert; also called by
   * `sweepIdleSessions` to close sessions the client never explicitly ended.
   *
   * `asOf` drives the idle-close rule: if the session is still open and has had
   * no activity for `IDLE_CLOSE_MS`, it is back-dated to the last event. Omit it
   * to leave a still-live session open.
   */
  async reconcileSession(sessionId: string, asOf?: Date): Promise<void> {
    const { rows } = await this.sql.query<{
      event_name: string;
      client_seq: string;
      occurred_at: Date;
      received_at: Date;
      payload: Record<string, unknown> | null;
    }>(
      `SELECT event_name, client_seq, occurred_at, received_at, payload
       FROM events.behavior_event WHERE session_id = $1::uuid ORDER BY client_seq`,
      [sessionId],
    );

    const window = reconstructSession(
      rows.map((row) => ({
        event_name: row.event_name,
        client_seq: Number(row.client_seq),
        occurred_at: new Date(row.occurred_at).getTime(),
        received_at: new Date(row.received_at).getTime(),
        payload: row.payload,
      })),
      asOf?.getTime(),
    );
    if (!window) return;

    await this.sql.query(
      `UPDATE events.session
       SET ended_at = $2::timestamptz, duration_ms = $3, active_ms = $4, discarded_ms = $5,
           client_active_ms = $6, end_reason = $7, scorable = $8, event_count = $9,
           heartbeat_count = $10, anomalies = $11::jsonb, reconstructed_at = now()
       WHERE id = $1::uuid`,
      [
        sessionId,
        window.endedAt === null ? null : new Date(window.endedAt).toISOString(),
        window.durationMs,
        window.activeMs,
        window.discardedMs,
        window.clientActiveMs,
        window.endReason,
        isScorableSession(window),
        window.eventCount,
        window.heartbeatCount,
        JSON.stringify(window.anomalies),
      ],
    );
  }

  /**
   * Close sessions the client never ended — tablets that ran out of battery,
   * tabs closed without unload, network drops mid-session.
   *
   * Finds sessions still marked `open` and reconciles them with the current
   * wall-clock time, which triggers the idle-close rule in `reconstructSession`
   * for sessions silent for more than `IDLE_CLOSE_MS` (30 minutes).
   *
   * Returns the number of sessions processed. Meant to be called from a cron
   * endpoint on a 5–10 minute cadence — frequent enough that the tail lag
   * never grows beyond one cadence interval beyond `IDLE_CLOSE_MS`.
   */
  async sweepIdleSessions(asOf: Date, limit = 100): Promise<number> {
    const { rows } = await this.sql.query<{ id: string }>(
      `SELECT id FROM events.session WHERE end_reason = 'open' ORDER BY started_at LIMIT $1`,
      [limit],
    );

    if (rows.length === 0) return 0;

    await Promise.all(rows.map((row) => this.reconcileSession(row.id, asOf)));
    return rows.length;
  }

  /**
   * Make sure a row exists for every session in the batch.
   *
   * `behavior_event.session_id` has no foreign key on purpose — an event must
   * never be lost because its `session.started` was in the batch that failed to
   * arrive — but the reconstruction and the `ml` views join `events.session`,
   * so a session that only ever appears in events would be invisible to both.
   * Insert a stub from the first event we see and let `reconcileSession` fill
   * in the real numbers.
   */
  private async ensureSessions(
    learnerId: string,
    events: readonly EventEnvelope[],
  ): Promise<void> {
    const earliest = new Map<string, number>();
    for (const envelope of events) {
      const at = uuidv7Timestamp(envelope.event_id);
      if (at === null) continue;
      const seen = earliest.get(envelope.session_id);
      if (seen === undefined || at < seen) earliest.set(envelope.session_id, at);
    }

    for (const [sessionId, startedAtMs] of earliest) {
      await this.sql.query(
        `INSERT INTO events.session (id, learner_id, started_at)
         VALUES ($1::uuid, $2::uuid, $3::timestamptz)
         ON CONFLICT (id) DO NOTHING`,
        [sessionId, learnerId, new Date(startedAtMs).toISOString()],
      );
    }
  }
}

/**
 * The consent scope an event needs.
 *
 * `consent.granted` and `consent.revoked` are the exception the registry marks
 * `service_operation`, and they have to be: a revocation happens at the moment
 * behaviour consent turns off, so gating it on behaviour consent would mean we
 * could never record that the guardian withdrew.
 */
export function requiredScope(eventName: string): string {
  return getEventDefinition(eventName)?.requiredConsentScope ?? DEFAULT_CONSENT_SCOPE;
}

function asUuid(value: string | null): string | null {
  return value !== null && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}
