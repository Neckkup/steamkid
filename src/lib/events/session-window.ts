/**
 * Session reconstruction — the server's own answer to "how long was this child
 * actually learning", derived from the event stream rather than believed from
 * the client.
 *
 * `events.session.active_ms` (PRO-3 `data-schema`) feeds every time-based growth
 * formula, and `app.attempt.active_time_on_item_ms` sits next to it. The client
 * already applies the idle rule in `activity.ts`, but the client is a browser on
 * a child's device: a tab left open over dinner, a clock two hours off, a
 * duplicated heartbeat after a reconnect. This module is the server half, and it
 * is deliberately suspicious of every number the client sent.
 *
 * Three rules, in order of how much damage they prevent:
 *
 *   1. **Open ≠ reading.** Active time is the sum of heartbeat deltas, never
 *      `ended_at − started_at`. A 40-minute lesson with 3 minutes of active time
 *      is a normal shape; scoring the 40 would corrupt every skill score built
 *      on it.
 *   2. **A delta may not exceed the wall-clock gap that produced it.** A client
 *      that claims 10 minutes of activity between two heartbeats 15 seconds
 *      apart is broken or lying; either way we keep the 15 seconds.
 *   3. **A gap is not activity.** No event for 30 minutes closes the session at
 *      the last thing the child actually did, not at the moment we noticed.
 *
 * Pure and clock-injected, like `activity.ts`: rows in, a window out. No
 * database, no `now()` except the one the caller passes for an idle sweep.
 */

import { HEARTBEAT_INTERVAL_MS, INTERACTION_TIMEOUT_MS } from "./activity";

/**
 * No event at all for this long ends the session, backdated to the last event.
 * From PRO-3 `behavior-events`: `session.ended` is emitted on pagehide, or by
 * the server after 30 minutes of silence when the tab died without one.
 */
export const IDLE_CLOSE_MS = 30 * 60_000;

/**
 * Tolerance added to the wall-clock gap before a heartbeat delta is clamped.
 * A heartbeat is scheduled every 15s but fires late under load, and the client
 * measures the interval it actually observed. Half an interval of slack keeps
 * honest jitter out of the anomaly count.
 */
export const HEARTBEAT_SLACK_MS = HEARTBEAT_INTERVAL_MS / 2;

/**
 * Cap on the first heartbeat's delta, which has no predecessor to measure
 * against. It can legitimately cover the stretch from `session.started` up to
 * the interaction timeout, so that is exactly what we allow.
 */
export const FIRST_HEARTBEAT_MAX_MS = INTERACTION_TIMEOUT_MS;

/**
 * Below this, a session's active time is noise — a mis-tap on a link, a prefetch
 * that mounted a lesson for a second. Kept in the table (it happened) but not
 * offered to scoring.
 */
export const MIN_SCORABLE_ACTIVE_MS = 5_000;

/** The subset of `events.behavior_event` this reconstruction needs. */
export interface SessionEventRow {
  readonly event_name: string;
  /** Client clock, in epoch milliseconds. Untrusted; may jump backwards. */
  readonly occurred_at: number;
  /** Server clock, in epoch milliseconds. Monotonic enough to bound a session. */
  readonly received_at: number;
  /** Per-session counter. The only ordering we trust. */
  readonly client_seq: number;
  readonly payload?: Readonly<Record<string, unknown>> | null;
}

export type SessionEndReason =
  | "explicit_logout"
  | "timeout"
  | "navigate_away"
  | "crash"
  | "idle_close"
  | "open";

export interface SessionWindow {
  readonly startedAt: number;
  /** Null only while the session is still open and has not gone idle. */
  readonly endedAt: number | null;
  readonly endReason: SessionEndReason;
  /** Wall-clock span. Present for context; never use it for scoring. */
  readonly durationMs: number;
  /** Server-authoritative active time: the number growth formulas may read. */
  readonly activeMs: number;
  /** What the client's own `session.ended` claimed, when it sent one. */
  readonly clientActiveMs: number | null;
  /** Milliseconds removed by rules 2 and 3. Non-zero is worth a look. */
  readonly discardedMs: number;
  readonly anomalies: readonly SessionAnomaly[];
  readonly eventCount: number;
  readonly heartbeatCount: number;
}

export type SessionAnomaly =
  /** A heartbeat claimed more active time than had elapsed since the last one. */
  | { readonly kind: "delta_exceeds_gap"; readonly clientSeq: number; readonly clampedMs: number }
  /** The client clock moved backwards mid-session; ordering came from `client_seq`. */
  | { readonly kind: "clock_went_backwards"; readonly clientSeq: number; readonly byMs: number }
  /** The client's `session.ended.active_ms` disagreed with the server's sum. */
  | { readonly kind: "client_active_ms_mismatch"; readonly byMs: number }
  /** Events arrived after the session had already been closed. */
  | { readonly kind: "event_after_end"; readonly clientSeq: number };

function readInt(payload: SessionEventRow["payload"], key: string): number | null {
  const value = payload?.[key];
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

/**
 * Reconstruct one session from its events.
 *
 * `rows` may arrive in any order and may contain duplicates the ingest endpoint
 * has already de-duplicated by `(learner_id, event_id)`; ordering here is by
 * `client_seq`, with `received_at` breaking ties, because two events emitted in
 * the same millisecond still have an order the device knew about.
 *
 * `asOf` is the sweep time for the idle rule. Omit it to leave a still-live
 * session open.
 */
export function reconstructSession(
  rows: readonly SessionEventRow[],
  asOf?: number,
): SessionWindow | null {
  if (rows.length === 0) return null;

  const ordered = [...rows].sort(
    (a, b) => a.client_seq - b.client_seq || a.received_at - b.received_at,
  );

  const anomalies: SessionAnomaly[] = [];
  const startedAt = ordered[0]!.occurred_at;

  let activeMs = 0;
  let discardedMs = 0;
  let heartbeatCount = 0;
  let clientActiveMs: number | null = null;
  let lastEventAt = startedAt;
  let lastHeartbeatAt: number | null = null;
  let endedAt: number | null = null;
  let endReason: SessionEndReason = "open";

  for (const row of ordered) {
    // A clock that jumps backwards must not create negative gaps or a session
    // that ends before it starts. `client_seq` already told us the real order,
    // so we hold the timeline still and record that it happened.
    const at = Math.max(row.occurred_at, lastEventAt);
    if (row.occurred_at < lastEventAt) {
      anomalies.push({
        kind: "clock_went_backwards",
        clientSeq: row.client_seq,
        byMs: lastEventAt - row.occurred_at,
      });
    }

    if (endedAt !== null) {
      // Late arrivals after `session.ended` are kept in the table but cannot
      // extend a session that is already closed.
      anomalies.push({ kind: "event_after_end", clientSeq: row.client_seq });
      continue;
    }

    if (row.event_name === "session.heartbeat") {
      heartbeatCount += 1;
      const claimed = Math.max(0, readInt(row.payload, "active_ms_delta") ?? 0);
      const allowed =
        lastHeartbeatAt === null ? FIRST_HEARTBEAT_MAX_MS : at - lastHeartbeatAt + HEARTBEAT_SLACK_MS;
      const credited = Math.min(claimed, Math.max(0, allowed));

      if (credited < claimed) {
        discardedMs += claimed - credited;
        anomalies.push({
          kind: "delta_exceeds_gap",
          clientSeq: row.client_seq,
          clampedMs: claimed - credited,
        });
      }

      activeMs += credited;
      lastHeartbeatAt = at;
    }

    if (row.event_name === "session.ended") {
      endedAt = at;
      const reason = row.payload?.["reason"];
      endReason = isEndReason(reason) ? reason : "crash";
      clientActiveMs = readInt(row.payload, "active_ms");
    }

    lastEventAt = at;
  }

  // Rule 3: silence is not activity. A tab that died without a `session.ended`
  // closes at the last thing the child actually did.
  if (endedAt === null && asOf !== undefined && asOf - lastEventAt >= IDLE_CLOSE_MS) {
    endedAt = lastEventAt;
    endReason = "idle_close";
    discardedMs += asOf - lastEventAt;
  }

  if (clientActiveMs !== null && clientActiveMs !== activeMs) {
    anomalies.push({ kind: "client_active_ms_mismatch", byMs: clientActiveMs - activeMs });
  }

  const durationMs = (endedAt ?? lastEventAt) - startedAt;

  return {
    startedAt,
    endedAt,
    endReason,
    durationMs,
    // Active time cannot exceed the wall clock it happened in, whatever the
    // heartbeats add up to.
    activeMs: Math.min(activeMs, Math.max(0, durationMs)),
    clientActiveMs,
    discardedMs,
    anomalies,
    eventCount: ordered.length,
    heartbeatCount,
  };
}

function isEndReason(value: unknown): value is SessionEndReason {
  return (
    value === "explicit_logout" ||
    value === "timeout" ||
    value === "navigate_away" ||
    value === "crash"
  );
}

/**
 * Whether this session's active time may be used for time-based scoring.
 *
 * Kept separate from the reconstruction on purpose: the row is always written
 * (the session happened), and the scoring layer asks this question later. An
 * unscorable session is still behaviour data — it just cannot say anything
 * about how long a child thought about a problem.
 */
export function isScorableSession(window: SessionWindow): boolean {
  return window.activeMs >= MIN_SCORABLE_ACTIVE_MS && window.heartbeatCount > 0;
}
