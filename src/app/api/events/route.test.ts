/**
 * `POST /api/events` driven end to end, against a real Postgres.
 *
 * `pg-sink.test.ts` proves the sink's three properties and `ingest.test.ts`
 * proves the validator's. Neither proves the thing a child's browser actually
 * talks to: the endpoint that has to resolve a learner from a cookie, hand the
 * batch to the sink, and answer identically whether the events were stored,
 * withheld for want of consent, or dropped because the cookie matched nobody.
 * That seam is where a privacy leak would live, so it is tested here rather
 * than assumed from its two halves.
 *
 * Everything below is synthetic. No real learner row exists in this repository.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/lib/db/test-database";
import { uuidv7 } from "@/lib/ids";

import type { EventEnvelope } from "@/lib/events/envelope";
import {
  buildLearnerJourney,
  journeyIds,
  seedEventRegistry,
  seedLearner,
  type SeededLearner,
} from "@/lib/events/fixtures";
import { LEARNER_COOKIE } from "@/lib/events/learner";
import { PostgresEventSink } from "@/lib/events/pg-sink";
import { setBehaviourDb } from "@/lib/events/runtime";
import { setEventSink } from "@/lib/events/sink";

const { POST } = await import("./route");

const ALL_SCOPES = [
  "service_operation",
  "ai_grading",
  "behaviour_events",
  "external_monitoring",
  "training_use",
];

/** 2026-09-19 09:00 UTC. Fixed so partition boundaries are not a coin toss. */
const T0 = Date.parse("2026-09-19T09:00:00.000Z");

let db: TestDatabase;
let consenting: SeededLearner;
let refusing: SeededLearner;
let journey: EventEnvelope[];

/** A request shaped the way the browser tracker shapes one. */
function post(events: readonly unknown[], publicRef: string | null): Promise<Response> {
  return POST(
    new Request("https://steamkid.test/api/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // A second, unrelated cookie so the header parser is exercised too.
        ...(publicRef === null
          ? {}
          : { cookie: `theme=dark; ${LEARNER_COOKIE}=${publicRef}; other=1` }),
      },
      body: JSON.stringify({ events }),
    }),
  );
}

async function storedCount(learnerId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM events.behavior_event WHERE learner_id = $1::uuid`,
    [learnerId],
  );
  return rows[0]!.n;
}

beforeAll(async () => {
  db = await createTestDatabase();
  await seedEventRegistry(db);

  consenting = await seedLearner(db, { email: "route-a@example.test", scopes: ALL_SCOPES });
  refusing = await seedLearner(db, {
    email: "route-b@example.test",
    scopes: ["service_operation", "ai_grading"],
  });

  journey = buildLearnerJourney(T0, journeyIds(T0));

  setBehaviourDb(db);
  setEventSink(new PostgresEventSink(db));
});

afterAll(async () => {
  setEventSink(null);
  setBehaviourDb(null);
  await db.close();
});

describe("POST /api/events", () => {
  it("stores a consenting learner's batch and reads it back in order", async () => {
    const batch = journey.slice(0, 10);
    const response = await post(batch, consenting.publicRef);

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      accepted: batch.length,
      rejected: 0,
    });

    const { rows } = await db.query<{ event_name: string }>(
      `SELECT e.event_name FROM events.behavior_event e
       JOIN app.learner l ON l.id = e.learner_id
       WHERE l.public_ref = $1::uuid
       ORDER BY e.client_seq`,
      [consenting.publicRef],
    );
    expect(rows.map((row) => row.event_name)).toEqual(batch.map((event) => event.event_name));
  });

  it("does not create a second fact when the device retries the same batch", async () => {
    const batch = journey.slice(0, 10);
    const before = await storedCount(consenting.learnerId);

    // A real retry rebuilds the batch, so the device clock has moved on. The
    // primary key is derived from `event_id`, not from the restamped clock.
    const retry = batch.map((event) => ({
      ...event,
      occurred_at: new Date(Date.parse(event.occurred_at) + 45_000).toISOString(),
    }));

    const response = await post(retry, consenting.publicRef);
    expect(response.status).toBe(202);
    expect(await storedCount(consenting.learnerId)).toBe(before);
  });

  it("stores nothing for a learner whose guardian declined behaviour tracking", async () => {
    // Fresh event ids, so nothing can be mistaken for de-duplication.
    const batch = journey.slice(0, 10).map((event) => ({ ...event, event_id: uuidv7(T0) }));

    const response = await post(batch, refusing.publicRef);

    expect(response.status).toBe(202);
    expect(await storedCount(refusing.learnerId)).toBe(0);
  });

  it("answers a withheld batch exactly as it answers a stored one", async () => {
    // The body shape is the privacy boundary: a client that could tell the two
    // apart could read one child's consent state from another child's browser.
    const batch = journey.slice(10, 14);

    const stored = await post(batch, consenting.publicRef);
    const withheld = await post(
      batch.map((event) => ({ ...event, event_id: uuidv7(T0) })),
      refusing.publicRef,
    );
    const unknownLearner = await post(
      batch.map((event) => ({ ...event, event_id: uuidv7(T0) })),
      uuidv7(),
    );
    const noCookie = await post(
      batch.map((event) => ({ ...event, event_id: uuidv7(T0) })),
      null,
    );

    expect(withheld.status).toBe(stored.status);
    expect(unknownLearner.status).toBe(stored.status);
    expect(noCookie.status).toBe(stored.status);

    const bodies = await Promise.all(
      [stored, withheld, unknownLearner, noCookie].map((response) => response.json()),
    );
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
    expect(bodies[3]).toEqual(bodies[0]);
  });

  it("creates no learner as a side effect of telemetry from an unknown cookie", async () => {
    const strangerRef = uuidv7();
    await post(journey.slice(0, 3), strangerRef);

    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.learner WHERE public_ref = $1::uuid`,
      [strangerRef],
    );
    expect(rows[0]!.n).toBe(0);
  });

  it("dead-letters an unknown event name without refusing the good events beside it", async () => {
    const good = journey.slice(14, 17).map((event) => ({ ...event, event_id: uuidv7(T0) }));
    const bad = {
      ...journey[14]!,
      event_id: uuidv7(T0),
      event_name: "lesson.definitely_not_in_the_registry",
    };

    const before = await storedCount(consenting.learnerId);
    const response = await post([...good, bad], consenting.publicRef);

    expect(response.status).toBe(202);
    const body = (await response.json()) as {
      accepted: number;
      rejected: number;
      rejections: readonly { event_name: string; reason: string }[];
    };
    expect(body.accepted).toBe(good.length);
    expect(body.rejected).toBe(1);
    expect(body.rejections[0]!.event_name).toBe("lesson.definitely_not_in_the_registry");

    expect(await storedCount(consenting.learnerId)).toBe(before + good.length);

    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM events.dead_letter WHERE learner_id = $1::uuid`,
      [consenting.learnerId],
    );
    expect(rows[0]!.n).toBe(1);
  });

  it("refuses a body that is not JSON, before reading a learner", async () => {
    const response = await POST(
      new Request("https://steamkid.test/api/events", {
        method: "POST",
        headers: { cookie: `${LEARNER_COOKIE}=${consenting.publicRef}` },
        body: "{not json",
      }),
    );
    expect(response.status).toBe(400);
  });

  it("refuses a batch larger than the contract allows", async () => {
    const oversized = Array.from({ length: 51 }, (_, index) => ({
      ...journey[index % journey.length]!,
      event_id: uuidv7(T0),
    }));

    const response = await post(oversized, consenting.publicRef);
    expect(response.status).toBe(413);
  });

  it("fails closed with 503 rather than accepting a batch it cannot store", async () => {
    setEventSink(null);
    setBehaviourDb(null);
    try {
      const response = await post(journey.slice(0, 2), consenting.publicRef);
      expect(response.status).toBe(503);
    } finally {
      setBehaviourDb(db);
      setEventSink(new PostgresEventSink(db));
    }
  });

  it("returns 503 event_store_unavailable when DATABASE_URL is set but Postgres is unreachable", async () => {
    // Simulates the real deployment scenario: a configured but unreachable DB.
    // Injecting null (above) is a different code path and does not catch this bug.
    const refusingDb = {
      query() {
        const err = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), {
          code: "ECONNREFUSED",
        });
        return Promise.reject(err);
      },
    };
    setBehaviourDb(refusingDb);
    setEventSink(new PostgresEventSink(refusingDb));
    try {
      const response = await post(journey.slice(0, 2), consenting.publicRef);
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        error: "event_store_unavailable",
      });
    } finally {
      setBehaviourDb(db);
      setEventSink(new PostgresEventSink(db));
    }
  });
});
