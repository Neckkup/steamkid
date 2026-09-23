import { describe, expect, it } from "vitest";

import { HEARTBEAT_INTERVAL_MS } from "./activity";
import {
  IDLE_CLOSE_MS,
  isScorableSession,
  MIN_SCORABLE_ACTIVE_MS,
  reconstructSession,
  type SessionEventRow,
} from "./session-window";

const T0 = 1_700_000_000_000;

/** Builds rows the way the ingest endpoint stores them, with a sane clock. */
function stream(base = T0) {
  const rows: SessionEventRow[] = [];
  let seq = 0;

  return {
    rows,
    at(offsetMs: number, event_name: string, payload?: Record<string, unknown>) {
      rows.push({
        event_name,
        occurred_at: base + offsetMs,
        received_at: base + offsetMs + 40,
        client_seq: (seq += 1),
        payload: payload ?? {},
      });
      return this;
    },
    /** `count` well-behaved heartbeats, each crediting a full interval. */
    heartbeats(fromMs: number, count: number, deltaMs = HEARTBEAT_INTERVAL_MS) {
      for (let index = 1; index <= count; index += 1) {
        this.at(fromMs + index * HEARTBEAT_INTERVAL_MS, "session.heartbeat", {
          active_ms_delta: deltaMs,
          route: "/lesson/fractions",
        });
      }
      return this;
    },
  };
}

describe("reconstructSession", () => {
  it("returns null for a session with no events", () => {
    expect(reconstructSession([])).toBeNull();
  });

  it("sums heartbeat deltas rather than the wall clock", () => {
    const s = stream().at(0, "session.started", { device_class: "tablet" });
    s.heartbeats(0, 8);
    s.at(2 * 60_000, "session.ended", { reason: "explicit_logout", active_ms: 120_000 });

    const window = reconstructSession(s.rows)!;

    expect(window.activeMs).toBe(8 * HEARTBEAT_INTERVAL_MS);
    expect(window.endReason).toBe("explicit_logout");
    expect(window.anomalies).toEqual([]);
  });

  it("keeps a tab left open over dinner out of active time", () => {
    // Three minutes of real work, then 50 minutes of an open tab, then the
    // child comes back and closes it. Dwell is an hour; learning is 3 minutes.
    const s = stream().at(0, "session.started", {});
    s.heartbeats(0, 12);
    s.at(53 * 60_000, "page.viewed", { route: "/" });
    s.at(54 * 60_000, "session.ended", { reason: "navigate_away", active_ms: 180_000 });

    const window = reconstructSession(s.rows)!;

    expect(window.durationMs).toBe(54 * 60_000);
    expect(window.activeMs).toBe(180_000);
    expect(isScorableSession(window)).toBe(true);
  });

  it("clamps a heartbeat that claims more time than has elapsed", () => {
    const s = stream().at(0, "session.started", {});
    s.heartbeats(0, 1);
    // A reconnect replays a stale clock and claims ten minutes for one interval.
    s.at(2 * HEARTBEAT_INTERVAL_MS, "session.heartbeat", { active_ms_delta: 600_000 });
    s.at(3 * HEARTBEAT_INTERVAL_MS, "session.ended", { reason: "timeout", active_ms: 615_000 });

    const window = reconstructSession(s.rows)!;

    // First heartbeat credited in full, the second capped at its gap + slack.
    expect(window.activeMs).toBe(HEARTBEAT_INTERVAL_MS + HEARTBEAT_INTERVAL_MS * 1.5);
    expect(window.discardedMs).toBe(600_000 - HEARTBEAT_INTERVAL_MS * 1.5);
    expect(window.anomalies).toContainEqual({
      kind: "delta_exceeds_gap",
      clientSeq: 3,
      clampedMs: 600_000 - HEARTBEAT_INTERVAL_MS * 1.5,
    });
    expect(window.anomalies).toContainEqual({
      kind: "client_active_ms_mismatch",
      byMs: 615_000 - window.activeMs,
    });
  });

  it("allows the first heartbeat up to the interaction timeout", () => {
    // A slow device fires its first heartbeat late; that stretch is real.
    const s = stream().at(0, "session.started", {});
    s.at(90_000, "session.heartbeat", { active_ms_delta: 90_000 });

    const window = reconstructSession(s.rows)!;

    expect(window.activeMs).toBe(90_000);
    expect(window.anomalies).toEqual([]);
  });

  it("orders by client_seq and holds the timeline still when the clock jumps back", () => {
    const rows: SessionEventRow[] = [
      { event_name: "session.started", occurred_at: T0, received_at: T0, client_seq: 1, payload: {} },
      {
        event_name: "session.heartbeat",
        occurred_at: T0 + 15_000,
        received_at: T0 + 15_000,
        client_seq: 2,
        payload: { active_ms_delta: 15_000 },
      },
      // Device clock corrects itself backwards by an hour mid-session.
      {
        event_name: "session.heartbeat",
        occurred_at: T0 - 3_600_000,
        received_at: T0 + 30_000,
        client_seq: 3,
        payload: { active_ms_delta: 15_000 },
      },
    ];

    const window = reconstructSession([rows[2]!, rows[0]!, rows[1]!])!;

    expect(window.durationMs).toBe(15_000);
    expect(window.anomalies).toContainEqual({
      kind: "clock_went_backwards",
      clientSeq: 3,
      byMs: 3_615_000,
    });
    // The jumped heartbeat has a zero gap, so only slack is creditable — and
    // the wall clock the jump left us with caps the total at 15s anyway.
    expect(window.activeMs).toBe(15_000);
  });

  it("closes a silent session at the last event, not at the sweep time", () => {
    const s = stream().at(0, "session.started", {});
    s.heartbeats(0, 4);

    const lastEventAt = T0 + 4 * HEARTBEAT_INTERVAL_MS;
    const window = reconstructSession(s.rows, lastEventAt + IDLE_CLOSE_MS + 60_000)!;

    expect(window.endReason).toBe("idle_close");
    expect(window.endedAt).toBe(lastEventAt);
    expect(window.durationMs).toBe(4 * HEARTBEAT_INTERVAL_MS);
    expect(window.activeMs).toBe(4 * HEARTBEAT_INTERVAL_MS);
  });

  it("leaves a session open while it is still inside the idle window", () => {
    const s = stream().at(0, "session.started", {});
    s.heartbeats(0, 2);

    const lastEventAt = T0 + 2 * HEARTBEAT_INTERVAL_MS;
    const window = reconstructSession(s.rows, lastEventAt + IDLE_CLOSE_MS - 1)!;

    expect(window.endedAt).toBeNull();
    expect(window.endReason).toBe("open");
  });

  it("does not let a late event extend a closed session", () => {
    const s = stream().at(0, "session.started", {});
    s.heartbeats(0, 2);
    s.at(60_000, "session.ended", { reason: "crash", active_ms: 30_000 });
    // A queued beacon from the dead tab arrives after the close.
    s.at(90_000, "session.heartbeat", { active_ms_delta: 15_000 });

    const window = reconstructSession(s.rows)!;

    expect(window.endedAt).toBe(T0 + 60_000);
    expect(window.activeMs).toBe(30_000);
    expect(window.anomalies).toContainEqual({ kind: "event_after_end", clientSeq: 5 });
  });

  it("treats an unknown end reason as a crash", () => {
    const s = stream().at(0, "session.started", {});
    s.at(10_000, "session.ended", { reason: "who_knows" });

    expect(reconstructSession(s.rows)!.endReason).toBe("crash");
  });

  it("refuses to score a session with no measured activity", () => {
    const s = stream().at(0, "session.started", {});
    s.at(800, "page.viewed", { route: "/" });
    s.at(1_000, "session.ended", { reason: "navigate_away", active_ms: 1_000 });

    const window = reconstructSession(s.rows)!;

    expect(window.activeMs).toBe(0);
    expect(window.activeMs).toBeLessThan(MIN_SCORABLE_ACTIVE_MS);
    expect(isScorableSession(window)).toBe(false);
  });

  it("never reports more active time than wall clock", () => {
    const s = stream().at(0, "session.started", {});
    // Two heartbeats in the same millisecond, each claiming a full interval.
    s.at(0, "session.heartbeat", { active_ms_delta: HEARTBEAT_INTERVAL_MS });
    s.at(0, "session.heartbeat", { active_ms_delta: HEARTBEAT_INTERVAL_MS });
    s.at(0, "session.ended", { reason: "explicit_logout", active_ms: 30_000 });

    const window = reconstructSession(s.rows)!;

    expect(window.durationMs).toBe(0);
    expect(window.activeMs).toBe(0);
  });
});
