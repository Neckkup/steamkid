/**
 * Prove the behaviour pipe, out loud.
 *
 * `npm run verify:pipeline`
 *
 * PRO-7's acceptance criteria are three claims that are only worth anything if
 * someone can watch them happen:
 *
 *   1. one test learner's behaviour reads back in order, from arriving on the
 *      site to submitting work
 *   2. delivering the same events twice does not create a second fact
 *   3. no consent means nothing is stored, and nothing reaches the export
 *
 * `pg-sink.test.ts` asserts all three and will fail a build. This script prints
 * them instead, because a reviewer should not have to read a test to believe a
 * pipeline works. It builds a throwaway Postgres from `prisma/migrations/`,
 * pushes a synthetic visit through the same gate and the same sink the endpoint
 * uses, and prints the rows that come back out.
 *
 * Every learner, lesson and answer here is invented. No real child's row exists
 * in this repository, and none is ever printed by this script — that is what
 * `public_ref` is for.
 */

import { createTestDatabase } from "@/lib/db/test-database";
import type { SqlExecutor } from "@/lib/db/sql";
import { uuidv7 } from "@/lib/ids";

import { validateBatch } from "@/lib/events/ingest";
import {
  buildLearnerJourney,
  journeyIds,
  makeEvent,
  seedEventRegistry,
  seedLearner,
} from "@/lib/events/fixtures";
import { PostgresEventSink } from "@/lib/events/pg-sink";
import { isScorableSession, reconstructSession } from "@/lib/events/session-window";

/** 2026-09-19 09:00 UTC. Fixed so a re-run prints the same thing. */
const T0 = Date.parse("2026-09-19T09:00:00.000Z");
const RECEIVED_AT = new Date(T0 + 600_000).toISOString();

const ALL_SCOPES = [
  "service_operation",
  "ai_grading",
  "behaviour_events",
  "external_monitoring",
  "training_use",
];

function heading(step: string, title: string): void {
  console.log(`\n${"=".repeat(78)}\n${step}  ${title}\n${"=".repeat(78)}`);
}

/** Minimal fixed-width table. Enough to be pasted into a ticket and read. */
function table(rows: readonly Record<string, unknown>[]): void {
  if (rows.length === 0) {
    console.log("(no rows)");
    return;
  }

  const columns = Object.keys(rows[0]!);
  const text = rows.map((row) =>
    Object.fromEntries(columns.map((column) => [column, format(row[column])])),
  );
  const width = Object.fromEntries(
    columns.map((column) => [
      column,
      Math.max(column.length, ...text.map((row) => row[column]!.length)),
    ]),
  );

  const line = (cells: readonly string[]) => cells.join("  ");
  console.log(line(columns.map((column) => column.padEnd(width[column]!))));
  console.log(line(columns.map((column) => "-".repeat(width[column]!))));
  for (const row of text) {
    console.log(line(columns.map((column) => row[column]!.padEnd(width[column]!))));
  }
  console.log(`(${rows.length} row${rows.length === 1 ? "" : "s"})`);
}

function format(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

async function show(sql: SqlExecutor, label: string, text: string, params: unknown[] = []) {
  console.log(`\n-- ${label}\n${text.trim()}\n`);
  const { rows } = await sql.query(text, params);
  table(rows);
  return rows;
}

async function main(): Promise<void> {
  heading("0", "A throwaway Postgres, built from prisma/migrations/");

  const db = await createTestDatabase();
  const sink = new PostgresEventSink(db);
  const registrySize = await seedEventRegistry(db);
  console.log(`migrations applied, events.event_registry seeded with ${registrySize} definitions`);

  // Two synthetic families. The difference between them is the only thing that
  // decides whether anything is stored.
  const consenting = await seedLearner(db, {
    email: "guardian-a@example.test",
    scopes: ALL_SCOPES,
  });
  const refusing = await seedLearner(db, {
    email: "guardian-b@example.test",
    // Everything except behaviour tracking. This child can still use the app.
    scopes: ["service_operation", "ai_grading"],
  });

  console.log(
    `\nlearner A  public_ref=${consenting.publicRef}  consent: ${ALL_SCOPES.join(", ")}`,
  );
  console.log(
    `learner B  public_ref=${refusing.publicRef}  consent: service_operation, ai_grading` +
      `  (no behaviour_events, no training_use)`,
  );

  const ids = journeyIds(T0);
  const journey = buildLearnerJourney(T0, ids);
  const context = { learnerId: consenting.learnerId, receivedAt: RECEIVED_AT };

  // The same gate the endpoint runs. Nothing here bypasses validation.
  const { accepted, rejected } = validateBatch(journey, RECEIVED_AT);
  console.log(
    `\ngate: ${accepted.length} of ${journey.length} events accepted, ${rejected.length} dead-lettered`,
  );

  const first = await sink.acceptWithOutcome(context, accepted);
  console.log(`sink: inserted=${first.inserted} duplicate=${first.duplicate} withheld=${first.withheld}`);

  await reconcile(db, ids.sessionId);

  heading("1", "One child's visit, read back in order — arriving to submitting");

  await show(
    db,
    "learner A's whole session, by the counter that survives a wrong device clock",
    `SELECT e.client_seq,
       to_char(e.event_time, 'HH24:MI:SS') AS event_time,
       e.event_name,
       e.consent_scope_at_write AS authorised_by,
       coalesce(e.correlation_id::text, '') <> '' AS has_trace
     FROM events.behavior_event e
     JOIN app.learner l ON l.id = e.learner_id
     WHERE l.public_ref = $1::uuid
     ORDER BY e.client_seq`,
    [consenting.publicRef],
  );

  await show(
    db,
    "the session row the events reconstruct, and whether its time may be scored",
    `SELECT to_char(s.started_at, 'HH24:MI:SS') AS started,
       to_char(s.ended_at, 'HH24:MI:SS') AS ended,
       s.duration_ms,
       s.active_ms,
       s.discarded_ms,
       s.end_reason,
       s.scorable,
       s.event_count
     FROM events.session s
     JOIN app.learner l ON l.id = s.learner_id
     WHERE l.public_ref = $1::uuid`,
    [consenting.publicRef],
  );

  await show(
    db,
    "one correlation id from the child's click to the AI call (the Langfuse trace id)",
    `SELECT e.correlation_id, count(*)::int AS events, string_agg(e.event_name, ' -> ' ORDER BY e.client_seq) AS chain
     FROM events.behavior_event e
     WHERE e.correlation_id IS NOT NULL
     GROUP BY e.correlation_id`,
  );

  heading("2", "A retrying device — the same visit delivered twice");

  // A real retry does not replay the same bytes: the tracker rebuilds the batch
  // and the device clock has moved on. `event_time` is derived from `event_id`,
  // so the restamped copy still lands on the same primary key.
  const retry = accepted.map((event) => ({
    ...event,
    occurred_at: new Date(Date.parse(event.occurred_at) + 45_000).toISOString(),
  }));

  const second = await sink.acceptWithOutcome(context, retry);
  console.log(
    `re-delivered ${retry.length} events with restamped clocks:` +
      ` inserted=${second.inserted} duplicate=${second.duplicate} withheld=${second.withheld}`,
  );

  await show(
    db,
    "distinct facts vs total deliveries — a retry must not become a second fact",
    `SELECT count(*)::int AS rows_stored,
       count(DISTINCT e.event_id)::int AS distinct_event_ids,
       count(DISTINCT e.client_seq)::int AS distinct_client_seq
     FROM events.behavior_event e
     JOIN app.learner l ON l.id = e.learner_id
     WHERE l.public_ref = $1::uuid`,
    [consenting.publicRef],
  );

  await show(
    db,
    "the stored occurred_at is the first one seen, not the retry's restamp",
    `SELECT e.event_name, to_char(e.occurred_at, 'HH24:MI:SS.MS') AS stored_occurred_at
     FROM events.behavior_event e
     JOIN app.learner l ON l.id = e.learner_id
     WHERE l.public_ref = $1::uuid AND e.client_seq IN (1, 18)
     ORDER BY e.client_seq`,
    [consenting.publicRef],
  );

  heading("3", "No consent means nothing is stored");

  // The identical visit, for the child whose guardian declined behaviour
  // tracking. Fresh event ids so nothing can be mistaken for de-duplication.
  const refusedVisit = accepted.map((event) => ({ ...event, event_id: uuidv7(T0) }));
  const refused = await sink.acceptWithOutcome(
    { learnerId: refusing.learnerId, receivedAt: RECEIVED_AT },
    refusedVisit,
  );
  console.log(
    `learner B, same ${refusedVisit.length}-event visit:` +
      ` inserted=${refused.inserted} duplicate=${refused.duplicate} withheld=${refused.withheld}`,
  );

  // A revocation is the exception: it happens at the moment behaviour consent
  // turns off, so gating it on behaviour consent would mean never recording it.
  await sink.acceptWithOutcome({ learnerId: refusing.learnerId, receivedAt: RECEIVED_AT }, [
    makeEvent(T0 + 10_000, 1, "consent.revoked", {
      policy_version: "2026-09-19.1",
      scopes: ["behaviour_events"],
      reason_code: "guardian_withdrew_all",
    }),
  ]);

  await show(
    db,
    "stored rows per learner, by what their guardian actually agreed to",
    // One row per learner. The scope list and the event count are each their own
    // subquery on purpose: joining both at once multiplies events by scopes and
    // prints a number five times too large.
    `SELECT l.public_ref,
       coalesce((SELECT string_agg(c.scope, ',' ORDER BY c.scope)
                 FROM app.consent_current c
                 WHERE c.learner_id = l.id AND c.granted), '(none)') AS granted_scopes,
       (SELECT count(*)::int FROM events.behavior_event e
        WHERE e.learner_id = l.id) AS events_stored
     FROM app.learner l
     ORDER BY events_stored DESC`,
  );

  heading("4", "The export excludes identity by construction, and consent by query");

  await show(
    db,
    "every column the behaviour export can emit — no learner_id, no name, no email",
    `SELECT string_agg(column_name, ', ' ORDER BY ordinal_position) AS columns
     FROM information_schema.columns
     WHERE table_schema = 'ml' AND table_name = 'v_behaviour_sequences'`,
  );

  await show(
    db,
    "who reaches the training export (training_use is opt-in and defaults to off)",
    `SELECT public_ref, grade_band FROM ml.v_consented_learner ORDER BY public_ref`,
  );

  await show(
    db,
    "the exported behaviour sequence: exportable events only, scorable sessions only",
    `SELECT learner_ref, grade_band, client_seq, event_name
     FROM ml.v_behaviour_sequences
     ORDER BY learner_ref, client_seq
     LIMIT 8`,
  );

  const exportable = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ml.v_behaviour_sequences`,
  );
  const stored = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM events.behavior_event`,
  );
  console.log(
    `\n${stored.rows[0]!.n} events stored, ${exportable.rows[0]!.n} of them exportable` +
      ` — the gap is non-exportable events and non-consenting learners, dropped by the view.`,
  );

  heading("5", "Withdrawing consent removes the learner from the export at once");

  // Append-only: a withdrawal is a new row, never an UPDATE of the old one.
  await db.query(
    `INSERT INTO app.consent_record
       (id, learner_id, guardian_user_id, policy_version, scope, granted, method, evidence)
     VALUES ($1::uuid, $2::uuid, $3::uuid, '2026-09-19.1', 'training_use', false,
             'guardian_web_verified_email', '{}'::jsonb)`,
    [uuidv7(), consenting.learnerId, consenting.guardianUserId],
  );

  await show(
    db,
    "the consent log keeps both answers; the current view follows the latest",
    // `effective_at` is the column; the winner is whatever app.consent_current
    // picks, which is the only read path anything else is allowed to use.
    `SELECT c.granted,
       to_char(c.effective_at, 'HH24:MI:SS.MS') AS effective_at,
       c.effective_at = cur.effective_at AS is_current
     FROM app.consent_record c
     JOIN app.consent_current cur
       ON cur.learner_id = c.learner_id AND cur.scope = c.scope
     WHERE c.learner_id = $1::uuid AND c.scope = 'training_use'
     ORDER BY c.effective_at, c.id`,
    [consenting.learnerId],
  );

  await show(
    db,
    "and the export is empty, while the behaviour history is untouched",
    `SELECT (SELECT count(*)::int FROM ml.v_consented_learner) AS learners_in_export,
       (SELECT count(*)::int FROM ml.v_behaviour_sequences) AS rows_in_behaviour_export,
       (SELECT count(*)::int FROM events.behavior_event) AS rows_still_stored`,
  );

  console.log(
    "\nHistory is not rewritten to honour a withdrawal — the events remain as facts" +
      " that happened, and the export simply stops selecting them.\n",
  );

  await db.close();
}

/**
 * Fill in the session row the way the app does after a visit.
 *
 * `reconstructSession` is the module that decides what counts as attention — a
 * tab left open over dinner is not forty minutes of study — and PRO-3 requires
 * every growth formula to read the trimmed figure. Called here so the printed
 * session row shows real numbers rather than the stub the sink inserts.
 */
async function reconcile(db: SqlExecutor, sessionId: string): Promise<void> {
  const { rows } = await db.query<{
    event_name: string;
    client_seq: string;
    occurred_at: Date;
    received_at: Date;
    payload: Record<string, unknown>;
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
  );
  if (!window) return;

  await db.query(
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

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
