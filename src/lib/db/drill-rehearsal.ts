/**
 * The restore drill, rehearsed on synthetic data in two PGlite instances.
 *
 * One copy of the procedure, two callers: `restore-drill.test.ts` asserts on
 * what it returns, and `scripts/restore-drill.ts` prints it so the evidence on
 * PRO-16 can be reproduced by anyone with a checkout. Two copies would drift,
 * and the printed one is what we show people.
 *
 * **Not the drill that opens the gate.** That one dumps the real managed
 * Postgres with `pg_dump` and is blocked on PRO-70. This rehearses the
 * *procedure* and, more importantly, proves that
 * `scripts/sql/backup-manifest.sql` — the file the real drill is judged by —
 * runs, round-trips, and can actually fail. PGlite is Postgres 17, so
 * `dumpDataDir()`/`loadDataDir` is a real data directory restored into a real,
 * separate instance.
 *
 * Test/CLI only, like `test-database.ts`: nothing in `src/app` may import it.
 * Every value here is invented. No real child exists in this repository.
 */

import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

import {
  buildLearnerJourney,
  journeyIds,
  seedEventRegistry,
  seedLearner,
  type SeededLearner,
} from "@/lib/events/fixtures";
import { PostgresEventSink } from "@/lib/events/pg-sink";
import { seedSkillMap } from "@/lib/growth/fixtures";
import { uuidv7 } from "@/lib/ids";
import { seedReviewDemo } from "@/lib/learning/review-fixtures";
import { SqlVerdictStore } from "@/lib/learning/verdict-store";

import { runBackupManifest, type ManifestLine } from "./backup-manifest";
import type { SqlExecutor } from "./sql";
import { createTestDatabase, type TestDatabase } from "./test-database";

const ALL_SCOPES = [
  "service_operation",
  "ai_grading",
  "behaviour_events",
  "external_monitoring",
  "training_use",
];

/**
 * Tables the manifest counts that this rehearsal leaves empty, and why.
 *
 * Nothing in the product writes a submission yet — the flow is content-led and
 * unbuilt. Listed rather than ignored so "zero" stays a recorded gap the real
 * drill has to close (runbook §5.2: a clean diff on an empty table proves
 * nothing), instead of an unnoticed one.
 */
export const UNSEEDED_MANIFEST_TABLES = ["app.submission", "app.submission_draft"];

export interface RehearsalResult {
  /** The source database, still open. Close it with `close()`. */
  readonly source: TestDatabase;
  /** The restored instance, a genuinely separate database. */
  readonly restored: SqlExecutor & { readonly pg: PGlite };
  /** Manifest of the source at the moment the dump was taken. */
  readonly manifestAtDump: ManifestLine[];
  /** Manifest of the source *after* more work landed — ahead of the backup. */
  readonly manifestSourceAfterDump: ManifestLine[];
  /** Manifest of the restored instance. Must equal `manifestAtDump`. */
  readonly manifestRestored: ManifestLine[];
  /** Size of the dump artifact, for the runbook's sizing note (§7). */
  readonly dumpBytes: number;
  /** Wall-clock milliseconds the restore took. */
  readonly restoreMs: number;
  readonly consenting: SeededLearner;
  /** A learner whose guardian refused behaviour tracking. */
  readonly refusing: SeededLearner;
  /** The session ingested after the dump: must be absent from the restore. */
  readonly laterSessionId: string;
  close(): Promise<void>;
}

function wrap(pg: PGlite): SqlExecutor & { readonly pg: PGlite } {
  return {
    pg,
    async query<Row = Record<string, unknown>>(text: string, params: readonly unknown[] = []) {
      const result = await pg.query<Row>(text, params as unknown[]);
      return { rows: result.rows };
    },
  };
}

/**
 * Seed a source database, back it up, move it forward, restore the backup.
 *
 * `t0` is an hour ago rather than a fixed date: the migrations create partitions
 * relative to `now()`, so a hard-coded timestamp would start failing in a future
 * month for a reason that has nothing to do with backups.
 */
export async function rehearseRestoreDrill(
  t0: number = Date.now() - 3_600_000,
): Promise<RehearsalResult> {
  /** The second visit, ingested after the dump is taken. */
  const t1 = t0 + 1_800_000;

  const source = await createTestDatabase();
  const sink = new PostgresEventSink(source);

  await seedSkillMap(source);
  await seedEventRegistry(source);

  const consenting = await seedLearner(source, {
    email: "guardian-drill-a@example.test",
    scopes: ALL_SCOPES,
  });
  // A child whose guardian refused behaviour tracking. Their absence from the
  // restored database is part of what a drill has to show: the consent gate is
  // structural, so a restore cannot turn it back on.
  const refusing = await seedLearner(source, {
    email: "guardian-drill-b@example.test",
    scopes: ["service_operation", "ai_grading"],
  });

  const firstVisit = journeyIds(t0);
  const journey = buildLearnerJourney(t0, firstVisit);
  const receivedAt = new Date(t0 + 600_000).toISOString();

  await sink.accept({ learnerId: consenting.learnerId, receivedAt }, journey);
  await sink.accept(
    { learnerId: refusing.learnerId, receivedAt },
    journey.map((event) => ({ ...event, event_id: uuidv7(t0) })),
  );

  // One quarantined event, so `events.dead_letter` is not empty in the
  // fingerprint. Field names and types only — never a value a child typed.
  await sink.deadLetter({ learnerId: consenting.learnerId, receivedAt }, [
    {
      event_id: uuidv7(t0),
      session_id: firstVisit.sessionId,
      event_name: "lesson.opened",
      event_version: 2,
      registry_version: "v1",
      occurred_at: new Date(t0).toISOString(),
      received_at: receivedAt,
      reason: "event_version_mismatch",
      detail: ["registry has version 1"],
      payload_shape: { lesson_id: "string" },
    },
  ]);

  // Verdicts, criteria and a teacher correction: the four-part training record
  // the whole dataset exists for.
  const demo = await seedReviewDemo(source, consenting.learnerId);
  await new SqlVerdictStore(source).recordOverride({
    verdictId: demo.verdictIds[demo.verdictIds.length - 1]!,
    teacherUserId: demo.teacherUserId,
    skillCode: "SCI.EXPLAIN_EVIDENCE",
    correctedLevel: 3,
    reasonCode: "too_harsh",
    note: "อ่านประโยคสุดท้ายแล้วเด็กเชื่อมหลักฐานกับแรงได้",
  });

  // Reading a child's nickname is an event we record, so the log has rows.
  await source.query(
    `INSERT INTO identity.pii_access_log (id, actor_user_id, actor_kind, learner_id, purpose)
     VALUES ($1::uuid, $2::uuid, 'user', $3::uuid, 'teacher_review')`,
    [uuidv7(), demo.teacherUserId, consenting.learnerId],
  );

  const manifestAtDump = await runBackupManifest(source);

  // ---- the backup ---------------------------------------------------------
  const dump = await source.pg.dumpDataDir("none");

  // ---- work that happens after the backup, and must therefore be missing
  //      from the restore --------------------------------------------------
  const secondVisit = journeyIds(t1);
  await sink.accept(
    { learnerId: consenting.learnerId, receivedAt: new Date(t1 + 600_000).toISOString() },
    buildLearnerJourney(t1, secondVisit),
  );
  const manifestSourceAfterDump = await runBackupManifest(source);

  // ---- the restore --------------------------------------------------------
  const startedAt = Date.now();
  const restored = wrap(
    await PGlite.create({ loadDataDir: dump, extensions: { citext, pgcrypto } }),
  );
  const restoreMs = Date.now() - startedAt;
  const manifestRestored = await runBackupManifest(restored);

  return {
    source,
    restored,
    manifestAtDump,
    manifestSourceAfterDump,
    manifestRestored,
    dumpBytes: dump.size,
    restoreMs,
    consenting,
    refusing,
    laterSessionId: secondVisit.sessionId,
    async close() {
      await source.close();
      await restored.pg.close();
    },
  };
}
