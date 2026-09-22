/**
 * The three things PRO-7 says must be true, checked against a real Postgres
 * built from the real migrations:
 *
 *   1. one test learner's behaviour can be read back in order, from arriving on
 *      the site to submitting work
 *   2. delivering the same events twice does not create a second copy
 *   3. no consent means nothing is stored, and nothing reaches the export
 *
 * Synthetic data throughout. No real learner row exists in this repository.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/lib/db/test-database";
import { uuidv7 } from "@/lib/ids";

import type { EventEnvelope } from "./envelope";
import {
  buildLearnerJourney,
  journeyIds,
  makeEvent,
  seedEventRegistry,
  seedLearner,
  type JourneyIds,
  type SeededLearner,
} from "./fixtures";
import { PostgresEventSink } from "./pg-sink";
import type { IngestContext } from "./sink";

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
let sink: PostgresEventSink;
let consenting: SeededLearner;
let refusing: SeededLearner;
let ids: JourneyIds;
let journey: EventEnvelope[];

function contextFor(learner: SeededLearner): IngestContext {
  return { learnerId: learner.learnerId, receivedAt: new Date(T0 + 600_000).toISOString() };
}

beforeAll(async () => {
  db = await createTestDatabase();
  sink = new PostgresEventSink(db);
  await seedEventRegistry(db);

  consenting = await seedLearner(db, { email: "guardian-a@example.test", scopes: ALL_SCOPES });
  refusing = await seedLearner(db, {
    email: "guardian-b@example.test",
    // Everything except behaviour tracking. The child can still use the app.
    scopes: ["service_operation", "ai_grading"],
  });

  ids = journeyIds(T0);
  journey = buildLearnerJourney(T0, ids);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe("migrations", () => {
  it("creates the four schemas the export rule depends on", async () => {
    const { rows } = await db.query<{ nspname: string }>(
      `SELECT nspname FROM pg_namespace
       WHERE nspname IN ('identity', 'app', 'events', 'ml') ORDER BY nspname`,
    );
    expect(rows.map((row) => row.nspname)).toEqual(["app", "events", "identity", "ml"]);
  });

  it("partitions behavior_event by month with no DEFAULT partition", async () => {
    const { rows } = await db.query<{ relname: string; is_default: boolean }>(
      `SELECT c.relname, pg_get_expr(c.relpartbound, c.oid) LIKE '%DEFAULT%' AS is_default
       FROM pg_class c
       JOIN pg_inherits i ON i.inhrelid = c.oid
       JOIN pg_class p ON p.oid = i.inhparent
       WHERE p.relname = 'behavior_event'`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(rows.some((row) => row.is_default)).toBe(false);
  });
});

describe("ingesting one learner's visit", () => {
  it("stores every event of the journey", async () => {
    const outcome = await sink.acceptWithOutcome(contextFor(consenting), journey);
    expect(outcome).toEqual({ inserted: journey.length, duplicate: 0, withheld: 0 });
  });

  it("reads the whole visit back in order, from arriving to submitting", async () => {
    const { rows } = await db.query<{ client_seq: string; event_name: string }>(
      `SELECT e.client_seq, e.event_name
       FROM events.behavior_event e
       JOIN app.learner l ON l.id = e.learner_id
       WHERE l.public_ref = $1::uuid
       ORDER BY e.client_seq`,
      [consenting.publicRef],
    );

    expect(rows.map((row) => row.event_name)).toEqual(journey.map((event) => event.event_name));
  });

  it("derives event_time from the id, so occurred_at is never the partition key", async () => {
    const { rows } = await db.query<{ mismatches: string }>(
      `SELECT count(*)::text AS mismatches FROM events.behavior_event
       WHERE event_time <> app.uuidv7_timestamp(event_id)`,
    );
    expect(rows[0]?.mismatches).toBe("0");
  });

  it("carries one correlation id from the child's click to the AI call", async () => {
    const { rows } = await db.query<{ event_name: string }>(
      `SELECT event_name FROM events.behavior_event
       WHERE correlation_id = $1::uuid ORDER BY client_seq`,
      [ids.correlationId],
    );
    expect(rows.map((row) => row.event_name)).toEqual([
      "item.answer_submitted",
      "feedback.viewed",
      "submission.submitted",
    ]);
  });

  it("records which consent scope authorised each write", async () => {
    const { rows } = await db.query<{ consent_scope_at_write: string; n: string }>(
      `SELECT consent_scope_at_write, count(*)::text AS n
       FROM events.behavior_event WHERE learner_id = $1::uuid
       GROUP BY 1`,
      [consenting.learnerId],
    );
    expect(rows).toEqual([{ consent_scope_at_write: "behaviour_events", n: String(journey.length) }]);
  });
});

describe("a retrying device", () => {
  it("does not create a second copy when the same batch arrives again", async () => {
    const before = await countEvents(consenting.learnerId);
    const outcome = await sink.acceptWithOutcome(contextFor(consenting), journey);

    expect(outcome.inserted).toBe(0);
    expect(outcome.duplicate).toBe(journey.length);
    expect(await countEvents(consenting.learnerId)).toBe(before);
  });

  it("does not create a second copy when the retry restamps its clock", async () => {
    // The failure mode §4.1 was written against: a buffer that builds
    // `occurred_at` at flush time rather than at the moment the event happened.
    const restamped = journey.map((event) => ({
      ...event,
      occurred_at: new Date(T0 + 900_000).toISOString(),
    }));

    const before = await countEvents(consenting.learnerId);
    const outcome = await sink.acceptWithOutcome(contextFor(consenting), restamped);

    expect(outcome.inserted).toBe(0);
    expect(await countEvents(consenting.learnerId)).toBe(before);
  });

  it("stores the first-seen occurred_at, not the restamped one", async () => {
    const { rows } = await db.query<{ occurred_at: Date }>(
      `SELECT occurred_at FROM events.behavior_event
       WHERE learner_id = $1::uuid ORDER BY client_seq LIMIT 1`,
      [consenting.learnerId],
    );
    expect(new Date(rows[0]!.occurred_at).toISOString()).toBe(new Date(T0).toISOString());
  });
});

describe("a guardian who said no to behaviour tracking", () => {
  it("stores nothing at all", async () => {
    const theirVisit = journey.map((event) => ({ ...event, event_id: uuidv7(T0 + 1) }));
    const outcome = await sink.acceptWithOutcome(contextFor(refusing), theirVisit);

    expect(outcome.inserted).toBe(0);
    expect(outcome.withheld).toBe(theirVisit.length);
    expect(await countEvents(refusing.learnerId)).toBe(0);
  });

  it("still records the consent events themselves", async () => {
    // A withdrawal happens at the moment behaviour consent turns off. Gating it
    // on behaviour consent would mean never being able to prove it happened.
    const revocation = makeEvent(T0 + 10_000, 1, "consent.revoked", {
      policy_version: "2026-09-19.1",
      scopes: ["behaviour_events"],
      reason_code: "guardian_request",
    });

    const outcome = await sink.acceptWithOutcome(contextFor(refusing), [revocation]);
    expect(outcome.inserted).toBe(1);

    const { rows } = await db.query<{ consent_scope_at_write: string }>(
      `SELECT consent_scope_at_write FROM events.behavior_event
       WHERE learner_id = $1::uuid`,
      [refusing.learnerId],
    );
    expect(rows).toEqual([{ consent_scope_at_write: "service_operation" }]);
  });
});

describe("the append-only rule", () => {
  it("refuses an UPDATE of a stored event", async () => {
    await expect(
      db.query(`UPDATE events.behavior_event SET event_name = 'tampered'`),
    ).rejects.toThrow(/append-only/);
  });

  it("refuses a DELETE of a stored event", async () => {
    await expect(
      db.query(`DELETE FROM events.behavior_event`),
    ).rejects.toThrow(/append-only/);
  });

  it("refuses to rewrite a consent record", async () => {
    await expect(
      db.query(`UPDATE app.consent_record SET granted = false`),
    ).rejects.toThrow(/append-only/);
  });
});

describe("withdrawing consent", () => {
  it("is a new row, and the current view follows it", async () => {
    await db.query(
      `INSERT INTO app.consent_record
         (id, learner_id, guardian_user_id, policy_version, scope, granted, method, evidence, effective_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, '2026-09-19.1', 'training_use', false,
               'guardian_web_verified_email', '{"ip_hash":"h","ua_hash":"h","ui_version":"1"}'::jsonb, now())`,
      [uuidv7(), consenting.learnerId, consenting.guardianUserId],
    );

    const { rows } = await db.query<{ granted: boolean; history: string }>(
      `SELECT c.granted,
              (SELECT count(*)::text FROM app.consent_record r
               WHERE r.learner_id = c.learner_id AND r.scope = c.scope) AS history
       FROM app.consent_current c
       WHERE c.learner_id = $1::uuid AND c.scope = 'training_use'`,
      [consenting.learnerId],
    );

    expect(rows[0]?.granted).toBe(false);
    // Both the grant and the withdrawal are still there to be audited.
    expect(rows[0]?.history).toBe("2");
  });

  it("removes the learner from the training export immediately", async () => {
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ml.v_consented_learner WHERE public_ref = $1::uuid`,
      [consenting.publicRef],
    );
    expect(rows[0]?.n).toBe("0");
  });

  it("leaves the behaviour rows in place — history is not rewritten", async () => {
    expect(await countEvents(consenting.learnerId)).toBe(journey.length);
  });
});

async function countEvents(learnerId: string): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM events.behavior_event WHERE learner_id = $1::uuid`,
    [learnerId],
  );
  return Number(rows[0]!.n);
}
