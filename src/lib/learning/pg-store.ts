/**
 * Postgres-backed LearningStore (PRO-169).
 *
 * Replaces MemoryLearningStore when RUNTIME_DATABASE_URL is set, so consent,
 * attempts and submissions survive Vercel cold starts and concurrent instances.
 * Wired by src/lib/learning/store-runtime.ts, which is called from
 * src/instrumentation.ts before the first request is handled.
 *
 * Three invariants carried over from the in-memory implementation:
 *
 *   - attempts are append-only: ON CONFLICT DO NOTHING on the primary key
 *     makes a retry of the same request a no-op instead of a duplicate row.
 *   - submission_draft rows are append-only: the database trigger enforces
 *     this; we write each draft once and never update it.
 *   - every draft is kept: the draft_count on app.submission drives the draft_no
 *     for the next insert, and both are incremented atomically in one CTE so
 *     concurrent requests cannot assign the same draft_no to two drafts.
 *
 * `learnerRef` is the pseudonymous public_ref (UUID) from the session cookie.
 * The internal `app.learner.id` never leaves this file.
 */

import { randomUUID } from "node:crypto";

import type { SqlExecutor } from "@/lib/db/sql";
import { uuidv7 } from "@/lib/ids";

import type {
  AttemptRecord,
  ConsentState,
  DraftRecord,
  LearningStore,
  SubmissionRecord,
} from "./store";
import { answerCharCount } from "./text";

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function maybeNum(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export class PostgresLearningStore implements LearningStore {
  constructor(private readonly sql: SqlExecutor) {}

  /**
   * Resolve app.learner.id from the public_ref cookie value.
   *
   * Returns null when no learner row exists yet (e.g., before the first
   * consent grant). Callers that cannot proceed without a learner row
   * return an empty result or attempt-no 1 rather than throwing.
   */
  private async resolveLearnerIdOrNull(learnerRef: string): Promise<string | null> {
    const { rows } = await this.sql.query<{ id: string }>(
      `SELECT id FROM app.learner WHERE public_ref = $1::uuid`,
      [learnerRef],
    );
    return rows[0]?.id ?? null;
  }

  /**
   * Upsert the learner row for this public_ref.
   *
   * consent/route.ts already does this after calling setConsent, but the two
   * operations run independently and the order is not guaranteed. Calling this
   * before any write that needs a learner FK makes both paths safe.
   */
  private async ensureLearner(learnerRef: string): Promise<string> {
    await this.sql.query(
      `INSERT INTO app.learner (id, public_ref, grade_band)
       VALUES ($1::uuid, $2::uuid, 'p5')
       ON CONFLICT (public_ref) DO NOTHING`,
      [uuidv7(), learnerRef],
    );
    const learnerId = await this.resolveLearnerIdOrNull(learnerRef);
    if (!learnerId) throw new Error(`learner row missing after upsert for ref ${learnerRef}`);
    return learnerId;
  }

  // -------------------------------------------------------------------------
  // Attempts
  // -------------------------------------------------------------------------

  async nextAttemptNo(learnerRef: string, itemId: string): Promise<number> {
    const learnerId = await this.resolveLearnerIdOrNull(learnerRef);
    if (!learnerId) return 1;
    const { rows } = await this.sql.query<{ count: string | number }>(
      `SELECT COUNT(*)::int AS count
       FROM app.attempt
       WHERE learner_id = $1::uuid AND item_id = $2::uuid`,
      [learnerId, itemId],
    );
    return (Number(rows[0]?.count) || 0) + 1;
  }

  async recordAttempt(attempt: AttemptRecord): Promise<void> {
    const learnerId = await this.ensureLearner(attempt.learnerRef);

    await this.sql.query(
      `INSERT INTO app.attempt (
         id, learner_id, item_id, lesson_id,
         attempt_no, submitted_at, answer_payload,
         time_on_item_ms, active_time_on_item_ms,
         answer_changes, hints_used,
         source, pending_ai, result, normalized_score,
         correlation_id
       )
       VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid,
         $5::int, $6::timestamptz, $7::jsonb,
         $8::int, $9::int,
         $10::int, $11::int,
         $12::text, $13::boolean, $14::text, $15::numeric,
         $16::uuid
       )
       ON CONFLICT DO NOTHING`,
      [
        attempt.id,
        learnerId,
        attempt.itemId,
        attempt.lessonId || null,
        attempt.attemptNo,
        attempt.submittedAt,
        JSON.stringify(attempt.answer),
        attempt.timeOnItemMs,
        attempt.activeTimeOnItemMs,
        attempt.answerChanges,
        attempt.hintsUsed,
        attempt.source,
        attempt.pendingAi,
        attempt.result ?? null,
        attempt.normalizedScore ?? null,
        attempt.correlationId,
      ],
    );
  }

  async listAttempts(learnerRef: string, lessonId: string): Promise<readonly AttemptRecord[]> {
    const learnerId = await this.resolveLearnerIdOrNull(learnerRef);
    if (!learnerId) return [];

    const { rows } = await this.sql.query<{
      id: string;
      item_id: string;
      lesson_id: string | null;
      attempt_no: number;
      answer_payload: unknown;
      time_on_item_ms: number;
      active_time_on_item_ms: number;
      answer_changes: number;
      hints_used: number;
      source: string;
      pending_ai: boolean;
      result: string | null;
      normalized_score: string | number | null;
      correlation_id: string;
      submitted_at: Date | string;
    }>(
      `SELECT id, item_id, lesson_id, attempt_no, answer_payload,
              time_on_item_ms, active_time_on_item_ms, answer_changes, hints_used,
              source, pending_ai, result, normalized_score, correlation_id, submitted_at
       FROM app.attempt
       WHERE learner_id = $1::uuid AND lesson_id = $2::uuid
       ORDER BY submitted_at ASC, id ASC`,
      [learnerId, lessonId],
    );

    return rows.map((row) => ({
      id: row.id,
      learnerRef,
      itemId: row.item_id,
      lessonId: row.lesson_id ?? lessonId,
      attemptNo: Number(row.attempt_no),
      answer: row.answer_payload,
      result: (row.result ?? null) as AttemptRecord["result"],
      normalizedScore: maybeNum(row.normalized_score),
      source: (row.source as AttemptRecord["source"]) ?? "deterministic",
      pendingAi: Boolean(row.pending_ai),
      timeOnItemMs: Number(row.time_on_item_ms),
      activeTimeOnItemMs: Number(row.active_time_on_item_ms),
      answerChanges: Number(row.answer_changes),
      hintsUsed: Number(row.hints_used),
      correlationId: row.correlation_id,
      submittedAt: iso(row.submitted_at),
    }));
  }

  // -------------------------------------------------------------------------
  // Submissions
  // -------------------------------------------------------------------------

  async saveDraft(input: {
    learnerRef: string;
    lessonId: string;
    itemId: string;
    submissionId: string | null;
    content: string;
    activeMsDelta: number;
  }): Promise<SubmissionRecord> {
    const learnerId = await this.ensureLearner(input.learnerRef);
    const contentJson = JSON.stringify(input.content);
    const charCount = answerCharCount(input.content);
    const activeMsDelta = Math.max(0, input.activeMsDelta);

    let submissionId: string;
    let isNew: boolean;

    if (input.submissionId) {
      const { rows } = await this.sql.query<{ learner_id: string }>(
        `SELECT learner_id FROM app.submission WHERE id = $1::uuid`,
        [input.submissionId],
      );
      if (rows[0]?.learner_id === learnerId) {
        submissionId = input.submissionId;
        isNew = false;
      } else {
        // Submission belongs to a different learner (or doesn't exist); create fresh.
        submissionId = randomUUID();
        isNew = true;
      }
    } else {
      submissionId = randomUUID();
      isNew = true;
    }

    if (isNew) {
      await this.sql.query(
        `WITH ins_sub AS (
           INSERT INTO app.submission (id, learner_id, lesson_id, item_id, content, total_active_ms, correlation_id, draft_count)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::jsonb, $6::int, $7::uuid, 1)
           RETURNING id
         ),
         ins_draft AS (
           INSERT INTO app.submission_draft (id, submission_id, draft_no, content, char_count)
           SELECT gen_random_uuid(), s.id, 1, $5::jsonb, $8::int
           FROM ins_sub s
           RETURNING 1
         )
         SELECT 1 FROM ins_sub, ins_draft`,
        [
          submissionId,
          learnerId,
          input.lessonId,
          input.itemId,
          contentJson,
          activeMsDelta,
          randomUUID(),
          charCount,
        ],
      );
    } else {
      // Increment draft_count atomically and use it as the new draft_no.
      await this.sql.query(
        `WITH upd AS (
           UPDATE app.submission
           SET draft_count = draft_count + 1,
               total_active_ms = total_active_ms + $2::int,
               content = $3::jsonb
           WHERE id = $1::uuid
           RETURNING draft_count
         ),
         ins_draft AS (
           INSERT INTO app.submission_draft (id, submission_id, draft_no, content, char_count)
           SELECT gen_random_uuid(), $1::uuid, upd.draft_count, $3::jsonb, $4::int
           FROM upd
           RETURNING 1
         )
         SELECT 1 FROM upd, ins_draft`,
        [submissionId, activeMsDelta, contentJson, charCount],
      );
    }

    return this.loadFullSubmission(learnerId, submissionId, input.learnerRef);
  }

  async submit(learnerRef: string, submissionId: string): Promise<SubmissionRecord | undefined> {
    const learnerId = await this.resolveLearnerIdOrNull(learnerRef);
    if (!learnerId) return undefined;

    await this.sql.query(
      `UPDATE app.submission
       SET submitted_at = now()
       WHERE id = $1::uuid AND learner_id = $2::uuid AND submitted_at IS NULL`,
      [submissionId, learnerId],
    );

    try {
      return await this.loadFullSubmission(learnerId, submissionId, learnerRef);
    } catch {
      return undefined;
    }
  }

  async getSubmission(
    learnerRef: string,
    submissionId: string,
  ): Promise<SubmissionRecord | undefined> {
    const learnerId = await this.resolveLearnerIdOrNull(learnerRef);
    if (!learnerId) return undefined;

    try {
      return await this.loadFullSubmission(learnerId, submissionId, learnerRef);
    } catch {
      return undefined;
    }
  }

  async listSubmissions(
    learnerRef: string,
    lessonId: string,
  ): Promise<readonly SubmissionRecord[]> {
    const learnerId = await this.resolveLearnerIdOrNull(learnerRef);
    if (!learnerId) return [];

    const { rows } = await this.sql.query<{
      sub_id: string;
      lesson_id: string;
      item_id: string | null;
      submitted_at: Date | string | null;
      total_active_ms: number;
      correlation_id: string;
      draft_no: number | null;
      draft_content: unknown;
      char_count: number | null;
      draft_created_at: Date | string | null;
    }>(
      `SELECT s.id AS sub_id, s.lesson_id, s.item_id, s.submitted_at,
              s.total_active_ms, s.correlation_id,
              d.draft_no, d.content AS draft_content, d.char_count,
              d.created_at AS draft_created_at
       FROM app.submission s
       LEFT JOIN app.submission_draft d ON d.submission_id = s.id
       WHERE s.learner_id = $1::uuid AND s.lesson_id = $2::uuid
       ORDER BY s.id ASC, d.draft_no ASC`,
      [learnerId, lessonId],
    );

    const byId = new Map<string, { meta: Omit<SubmissionRecord, "drafts">; drafts: DraftRecord[] }>();

    for (const row of rows) {
      if (!byId.has(row.sub_id)) {
        byId.set(row.sub_id, {
          meta: {
            id: row.sub_id,
            learnerRef,
            lessonId: row.lesson_id,
            itemId: row.item_id ?? "",
            submittedAt: row.submitted_at ? iso(row.submitted_at) : null,
            totalActiveMs: Number(row.total_active_ms),
            correlationId: row.correlation_id,
            verdict: null,
          },
          drafts: [],
        });
      }
      if (row.draft_no !== null) {
        byId.get(row.sub_id)!.drafts.push({
          draftNo: Number(row.draft_no),
          content: draftContent(row.draft_content),
          charCount: Number(row.char_count ?? 0),
          createdAt: iso(row.draft_created_at),
        });
      }
    }

    return [...byId.values()].map(({ meta, drafts }) => ({ ...meta, drafts }));
  }

  private async loadFullSubmission(
    learnerId: string,
    submissionId: string,
    learnerRef: string,
  ): Promise<SubmissionRecord> {
    const { rows } = await this.sql.query<{
      sub_id: string;
      lesson_id: string;
      item_id: string | null;
      submitted_at: Date | string | null;
      total_active_ms: number;
      correlation_id: string;
      draft_no: number | null;
      draft_content: unknown;
      char_count: number | null;
      draft_created_at: Date | string | null;
    }>(
      `SELECT s.id AS sub_id, s.lesson_id, s.item_id, s.submitted_at,
              s.total_active_ms, s.correlation_id,
              d.draft_no, d.content AS draft_content, d.char_count,
              d.created_at AS draft_created_at
       FROM app.submission s
       LEFT JOIN app.submission_draft d ON d.submission_id = s.id
       WHERE s.learner_id = $1::uuid AND s.id = $2::uuid
       ORDER BY d.draft_no ASC`,
      [learnerId, submissionId],
    );

    if (rows.length === 0) throw new Error(`submission ${submissionId} not found for learner`);

    const first = rows[0]!;
    const drafts: DraftRecord[] = rows
      .filter((r) => r.draft_no !== null)
      .map((r) => ({
        draftNo: Number(r.draft_no),
        content: draftContent(r.draft_content),
        charCount: Number(r.char_count ?? 0),
        createdAt: iso(r.draft_created_at),
      }));

    return {
      id: first.sub_id,
      learnerRef,
      lessonId: first.lesson_id,
      itemId: first.item_id ?? "",
      drafts,
      submittedAt: first.submitted_at ? iso(first.submitted_at) : null,
      totalActiveMs: Number(first.total_active_ms),
      correlationId: first.correlation_id,
      verdict: null,
    };
  }

  // -------------------------------------------------------------------------
  // Consent
  // -------------------------------------------------------------------------

  async getConsent(learnerRef: string): Promise<ConsentState | undefined> {
    const { rows } = await this.sql.query<{
      policy_version: string;
      scopes: string[];
      granted_at: Date | string;
    }>(
      `SELECT lcc.policy_version, lcc.scopes, lcc.granted_at
       FROM app.learner_consent_cache lcc
       JOIN app.learner l ON l.id = lcc.learner_id
       WHERE l.public_ref = $1::uuid`,
      [learnerRef],
    );

    const row = rows[0];
    if (!row) return undefined;

    return {
      policyVersion: row.policy_version,
      scopes: row.scopes,
      grantedAt: iso(row.granted_at),
    };
  }

  async setConsent(learnerRef: string, consent: ConsentState | null): Promise<void> {
    if (consent) {
      // Upsert the learner row before inserting the consent FK reference.
      await this.sql.query(
        `INSERT INTO app.learner (id, public_ref, grade_band)
         VALUES ($1::uuid, $2::uuid, 'p5')
         ON CONFLICT (public_ref) DO NOTHING`,
        [uuidv7(), learnerRef],
      );

      await this.sql.query(
        `INSERT INTO app.learner_consent_cache (learner_id, policy_version, scopes, granted_at)
         SELECT l.id, $2::text, $3::text[], $4::timestamptz
         FROM app.learner l
         WHERE l.public_ref = $1::uuid
         ON CONFLICT (learner_id) DO UPDATE
           SET policy_version = EXCLUDED.policy_version,
               scopes         = EXCLUDED.scopes,
               granted_at     = EXCLUDED.granted_at,
               updated_at     = now()`,
        [learnerRef, consent.policyVersion, consent.scopes, consent.grantedAt],
      );
    } else {
      // Withdrawal: remove the cache entry. The learner row itself is kept.
      await this.sql.query(
        `DELETE FROM app.learner_consent_cache
         WHERE learner_id = (SELECT id FROM app.learner WHERE public_ref = $1::uuid)`,
        [learnerRef],
      );
    }
  }
}

/**
 * Normalise a jsonb draft content column back to a plain string.
 *
 * The store writes `JSON.stringify(content)` (a JSON string) into the jsonb
 * column. Both `pg` and PGlite parse jsonb columns automatically, so the
 * driver hands back the JavaScript string value. This helper handles the
 * edge case where the driver returns an object instead of a string.
 */
function draftContent(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}
