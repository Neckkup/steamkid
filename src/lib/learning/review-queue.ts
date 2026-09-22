/**
 * What the teacher review screens read (PRO-77).
 *
 * `verdict-store.ts` answers "what is this one verdict, after corrections".
 * Two questions the screens also need are not on that interface, and both are
 * reads rather than writes, so they live here instead of widening it:
 *
 *   1. **which verdicts are waiting for a teacher**, across learners
 *   2. **whose work was it, and what did they actually write**
 *
 * The ordering rule is the reason this file has a comment at all. A verdict
 * whose status is not `graded` is one the model produced *no score* for, which
 * means the child has been shown "ส่งให้ครูดูแล้ว" and is still waiting. A
 * `graded` verdict has already reached them. So the queue is sorted by "is a
 * child still waiting" first and by age second — oldest first inside the
 * waiting group, because the longest wait is the one that matters, and newest
 * first inside the graded group, because that half is browsing rather than a
 * queue.
 *
 * Nothing here computes a score. `app.score_effective` is the one definition of
 * what a verdict is worth after a teacher has touched it, and a second sum in
 * this file is how a queue row eventually disagrees with the page it links to.
 */

import type { SqlExecutor } from "@/lib/db/sql";

import type { UnscorableReason, VerdictStatus, VerdictSubjectType } from "./verdict-store";

/**
 * Is a child still waiting on a human for this verdict?
 *
 * `blocked_by_safety` and `unscorable` both mean the model declined to produce
 * a level, so there is nothing for the child to read yet. Exported because the
 * queue page and the detail page must agree on the answer.
 */
export function awaitsTeacher(status: VerdictStatus): boolean {
  return status !== "graded";
}

export interface ReviewQueueEntry {
  readonly verdictId: string;
  readonly status: VerdictStatus;
  /** `app.learner.public_ref` — the only learner id allowed on a URL. */
  readonly learnerRef: string;
  /** Nickname. Teacher surfaces only, and never leaves the server bundle. */
  readonly learnerName: string | null;
  readonly itemId: string;
  readonly attemptNumber: number;
  readonly createdAt: string;
  /** True while no human has looked and the model gave no score. */
  readonly awaitingTeacher: boolean;
  readonly teacherCorrected: boolean;
  readonly correctedSkillCount: number;
  /** The model's own words about the refusal. Teacher-facing, never a child's. */
  readonly statusDetail: string | null;
  readonly unscorableReason: UnscorableReason | null;
}

/**
 * The context around one verdict: whose it was and what they wrote.
 *
 * `answer` is `app.ai_verdict.input_snapshot` — what the model was actually
 * given, after redaction — rather than `app.attempt.answer_payload`. A teacher
 * here is auditing a machine's judgement, and the only text that can settle
 * "was the AI fair" is the text the AI read. It is also the only answer text a
 * `blocked_by_safety` verdict has at all, because the model never got to the
 * point of producing anything else.
 */
export interface ReviewSubject {
  readonly verdictId: string;
  readonly learnerRef: string;
  readonly learnerName: string | null;
  readonly subjectType: VerdictSubjectType;
  readonly itemId: string;
  readonly attemptNumber: number;
  /** Also the Langfuse trace id — the two are one column by CHECK constraint. */
  readonly correlationId: string;
  readonly model: string;
  readonly promptName: string;
  readonly promptVersion: number;
  readonly rubricVersion: string;
  readonly redactionVersion: string;
  /** The child's answer as the model received it, or null if it is not text. */
  readonly answer: string | null;
  readonly createdAt: string;
}

export interface ReviewQueue {
  list(limit?: number): Promise<readonly ReviewQueueEntry[]>;
  subject(verdictId: string): Promise<ReviewSubject | null>;
}

/**
 * Where the child's text sits inside `input_snapshot`.
 *
 * The column is `jsonb` with no schema, and the writer is the grading call in
 * `ai-grade.ts`, which has not been wired to `save()` yet. Rather than guess
 * one key and render nothing when it turns out to be another, the reader tries
 * the plausible ones and falls back to showing the raw JSON — a teacher seeing
 * an unfamiliar blob can still review, whereas a teacher seeing an empty card
 * cannot. `answer` is the key to standardise on.
 */
const ANSWER_KEYS = ["answer", "learnerAnswer", "answerText", "text", "response"] as const;

export function answerText(snapshot: unknown): string | null {
  if (snapshot === null || snapshot === undefined) return null;
  if (typeof snapshot === "string") return snapshot.trim() || null;

  if (typeof snapshot === "object") {
    const record = snapshot as Record<string, unknown>;
    for (const key of ANSWER_KEYS) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return JSON.stringify(snapshot, null, 2);
  }

  return String(snapshot);
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

interface QueueRow {
  id: string;
  verdict_status: VerdictStatus;
  public_ref: string;
  display_name: string | null;
  item_id: string;
  attempt_number: number;
  created_at: Date | string;
  status_detail: string | null;
  unscorable_reason: UnscorableReason | null;
  teacher_corrected: boolean | null;
  corrected_skill_count: string | number | null;
}

export class SqlReviewQueue implements ReviewQueue {
  constructor(private readonly sql: SqlExecutor) {}

  async list(limit = 50): Promise<readonly ReviewQueueEntry[]> {
    const { rows } = await this.sql.query<QueueRow>(
      `SELECT v.id, v.verdict_status, v.item_id, v.attempt_number, v.created_at,
              v.status_detail, v.unscorable_reason,
              l.public_ref, p.display_name,
              se.teacher_corrected, se.corrected_skill_count
       FROM app.ai_verdict v
       JOIN app.learner l ON l.id = v.learner_id
       LEFT JOIN identity.learner_profile p ON p.learner_id = v.learner_id
       LEFT JOIN app.score_effective se ON se.verdict_id = v.id
       -- "a child is still waiting" first, then oldest wait inside that group.
       ORDER BY (v.verdict_status <> 'graded') DESC,
                CASE WHEN v.verdict_status <> 'graded' THEN v.created_at END ASC,
                v.created_at DESC
       LIMIT $1`,
      [limit],
    );

    return rows.map((row) => ({
      verdictId: row.id,
      status: row.verdict_status,
      learnerRef: row.public_ref,
      learnerName: row.display_name,
      itemId: row.item_id,
      attemptNumber: row.attempt_number,
      createdAt: iso(row.created_at),
      awaitingTeacher: awaitsTeacher(row.verdict_status),
      teacherCorrected: row.teacher_corrected ?? false,
      correctedSkillCount: Number(row.corrected_skill_count ?? 0),
      statusDetail: row.status_detail,
      unscorableReason: row.unscorable_reason,
    }));
  }

  async subject(verdictId: string): Promise<ReviewSubject | null> {
    const { rows } = await this.sql.query<{
      id: string;
      subject_type: VerdictSubjectType;
      item_id: string;
      attempt_number: number;
      correlation_id: string;
      model: string;
      prompt_name: string;
      prompt_version: number;
      rubric_version: string;
      redaction_version: string;
      input_snapshot: unknown;
      created_at: Date | string;
      public_ref: string;
      display_name: string | null;
    }>(
      `SELECT v.id, v.subject_type, v.item_id, v.attempt_number, v.correlation_id,
              v.model, v.prompt_name, v.prompt_version, v.rubric_version,
              v.redaction_version, v.input_snapshot, v.created_at,
              l.public_ref, p.display_name
       FROM app.ai_verdict v
       JOIN app.learner l ON l.id = v.learner_id
       LEFT JOIN identity.learner_profile p ON p.learner_id = v.learner_id
       WHERE v.id = $1::uuid`,
      [verdictId],
    );

    const row = rows[0];
    if (!row) return null;

    return {
      verdictId: row.id,
      learnerRef: row.public_ref,
      learnerName: row.display_name,
      subjectType: row.subject_type,
      itemId: row.item_id,
      attemptNumber: row.attempt_number,
      correlationId: row.correlation_id,
      model: row.model,
      promptName: row.prompt_name,
      promptVersion: row.prompt_version,
      rubricVersion: row.rubric_version,
      redactionVersion: row.redaction_version,
      answer: answerText(row.input_snapshot),
      createdAt: iso(row.created_at),
    };
  }
}
