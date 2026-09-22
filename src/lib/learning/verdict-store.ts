/**
 * Where an AI verdict and a teacher's correction of it are kept (PRO-76).
 *
 * The engine in `ai-grade.ts` returns an `AiVerdict` and, until this file
 * existed, that verdict died when the request ended. Two properties matter more
 * than anything else here, and both are held by the database rather than by
 * this code:
 *
 *   1. **A refusal is not a zero.** `blocked_by_safety`, `unscorable` and
 *      `graded` are three stored statuses, and `normalized_score` is NULL
 *      unless the status is `graded` — a CHECK constraint, not a convention. A
 *      child can never be shown a score the model declined to give.
 *   2. **A correction is a new row.** `app.teacher_correction` is append-only
 *      and carries `original_level` beside `corrected_level`. The pair is the
 *      training example; overwriting the AI's level would keep the right answer
 *      and throw away where the model went wrong, which is the half that
 *      teaches. A teacher who changes their mind twice leaves two rows.
 *
 * Both writes are single statements. `SqlExecutor` is satisfied by `pg.Pool`,
 * which does not promise that two `query()` calls share a connection, so a
 * verdict and its criteria are inserted by one statement with data-modifying
 * CTEs rather than by a `BEGIN`/`COMMIT` pair that a pool could split.
 *
 * `learnerId` here is `app.learner.id` and never leaves this layer.
 */

import type { SqlExecutor } from "@/lib/db/sql";
import { uuidv7 } from "@/lib/ids";

import type { AiVerdict } from "./ai-grade";
import { toResultBand } from "./ai-grade";
import type { ItemResult } from "./grade";
import type { RubricLevel } from "./rubric";

export type VerdictStatus = "graded" | "blocked_by_safety" | "unscorable";
export type UnscorableReason = "too_short" | "off_topic" | "unparseable";
export type CorrectionReasonCode =
  | "too_harsh"
  | "too_lenient"
  | "missed_criterion"
  | "wrong_reasoning"
  | "other";

/** `app.ai_verdict.subject_type`. */
export type VerdictSubjectType = "attempt" | "submission";

export interface SaveVerdictInput {
  /** Exactly what `gradeWritten()` returned. Nothing is recomputed from it. */
  readonly verdict: AiVerdict;
  /** `app.learner.id`. Never `public_ref` — this is the internal key. */
  readonly learnerId: string;
  readonly subjectType: VerdictSubjectType;
  /** `app.attempt.id` or `app.submission.id`. */
  readonly subjectId: string;
  readonly attemptNumber: number;
  /**
   * The client-minted id that is also the Langfuse trace id. A CHECK constraint
   * requires `langfuse_trace_id = correlation_id`, so passing two different
   * values is rejected by the database rather than quietly stored.
   */
  readonly correlationId: string;
  /** What was actually sent to the model, after redaction. */
  readonly inputSnapshot: unknown;
  readonly redactionVersion: string;
  readonly rubricVersionId?: string | null;
  /** Override for tests; production mints a UUIDv7. */
  readonly id?: string;
}

export interface StoredCriterion {
  readonly skillCode: string;
  readonly level: RubricLevel;
  readonly weight: number;
  readonly reason: string;
  readonly evidence: string | null;
}

export interface StoredVerdict {
  readonly id: string;
  readonly status: VerdictStatus;
  readonly learnerId: string;
  readonly subjectType: VerdictSubjectType;
  readonly subjectId: string;
  readonly itemId: string;
  readonly attemptNumber: number;
  readonly correlationId: string;
  readonly model: string;
  readonly promptName: string;
  readonly promptVersion: number;
  readonly rubricVersion: string;
  readonly gradeVersion: string;
  readonly normalizedScore: number | null;
  readonly result: ItemResult | null;
  readonly unscorableReason: UnscorableReason | null;
  readonly blockedStage: "prompt" | "response" | null;
  readonly statusDetail: string | null;
  readonly feedbackToLearner: string | null;
  readonly nextStep: string | null;
  readonly instructionAttempt: boolean;
  readonly costUsd: number | null;
  readonly latencyMs: number;
  readonly createdAt: string;
  readonly criteria: readonly StoredCriterion[];
}

export interface TeacherOverrideInput {
  readonly verdictId: string;
  /** `identity.user_account.id`. The role is read from that row, never trusted from the caller. */
  readonly teacherUserId: string;
  readonly skillCode: string;
  readonly correctedLevel: RubricLevel;
  readonly reasonCode: CorrectionReasonCode;
  /** What the teacher typed. Optional, but the screen should ask. */
  readonly note?: string | null;
  readonly correctedFeedback?: string | null;
  readonly id?: string;
}

export interface TeacherOverride {
  readonly id: string;
  readonly verdictId: string;
  readonly skillCode: string;
  /** The AI's level, read out of `app.ai_verdict_criterion` — not from the request. */
  readonly originalLevel: RubricLevel;
  readonly correctedLevel: RubricLevel;
  readonly reasonCode: CorrectionReasonCode;
  readonly note: string | null;
  readonly createdAt: string;
}

/** Why an override could not be written. Each maps to one HTTP status. */
export type OverrideFailure = "unknown_verdict" | "unknown_skill" | "not_a_teacher";

export class OverrideRejected extends Error {
  constructor(readonly failure: OverrideFailure) {
    super(`teacher override rejected: ${failure}`);
    this.name = "OverrideRejected";
  }
}

/**
 * The verdict was not stored because the learner has no `ai_grading` consent.
 *
 * Thrown rather than returned so it cannot be ignored by a caller reading only
 * the happy path. It means the grading call should not have been made at all —
 * `POST /api/attempts` gates on consent before reaching the grader — so this
 * firing is a bug upstream, not a routine outcome.
 */
export class ConsentMissing extends Error {
  constructor(readonly learnerId: string) {
    super("no ai_grading consent for this learner; verdict not stored");
    this.name = "ConsentMissing";
  }
}

/** The consent scope a stored AI verdict requires. */
export const VERDICT_CONSENT_SCOPE = "ai_grading";

/** One skill on a verdict, after any teacher correction. */
export interface EffectiveCriterion {
  readonly skillCode: string;
  readonly weight: number;
  /** What the AI said. Kept visible so a teacher screen can show what changed. */
  readonly aiLevel: RubricLevel;
  /** The level that counts. */
  readonly level: RubricLevel;
  readonly teacherCorrected: boolean;
  readonly reason: string;
  readonly evidence: string | null;
}

/**
 * What a screen should show for one verdict.
 *
 * `normalizedScore` and `result` are the *corrected* figures when a teacher has
 * touched any skill — a child's summary must read the score a human stands
 * behind, not the raw model output. `aiNormalizedScore` keeps the original for
 * the teacher view and for the training export.
 */
export interface EffectiveVerdict {
  readonly verdictId: string;
  readonly status: VerdictStatus;
  readonly itemId: string;
  readonly attemptNumber: number;
  readonly correlationId: string;
  readonly feedbackToLearner: string | null;
  readonly nextStep: string | null;
  readonly statusDetail: string | null;
  readonly unscorableReason: UnscorableReason | null;
  readonly aiNormalizedScore: number | null;
  readonly normalizedScore: number | null;
  readonly result: ItemResult | null;
  readonly teacherCorrected: boolean;
  readonly correctedSkillCount: number;
  readonly criteria: readonly EffectiveCriterion[];
  readonly createdAt: string;
}

export interface VerdictStore {
  save(input: SaveVerdictInput): Promise<StoredVerdict>;
  recordOverride(input: TeacherOverrideInput): Promise<TeacherOverride>;
  /** The verdict with teacher corrections applied, or null when there is none. */
  getEffective(verdictId: string): Promise<EffectiveVerdict | null>;
  /** The newest verdict for one piece of work, corrections applied. */
  latestForSubject(
    subjectType: VerdictSubjectType,
    subjectId: string,
  ): Promise<EffectiveVerdict | null>;
  /**
   * As `latestForSubject`, scoped to one learner.
   *
   * The read a child's own screen must use. It is a separate method rather than
   * an optional argument because an optional scope is one a caller forgets, and
   * the thing forgetting it shows is another child's grade.
   */
  latestForLearnerSubject(
    learnerId: string,
    subjectType: VerdictSubjectType,
    subjectId: string,
  ): Promise<EffectiveVerdict | null>;
  listOverrides(verdictId: string): Promise<readonly TeacherOverride[]>;
}

/** Postgres `numeric` arrives as a string through both `pg` and PGlite. */
function num(value: unknown, fallback: number): number {
  if (value === null || value === undefined) return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function maybeNum(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

interface VerdictRow {
  id: string;
  verdict_status: VerdictStatus;
  learner_id: string;
  subject_type: VerdictSubjectType;
  subject_id: string;
  item_id: string;
  attempt_number: number;
  correlation_id: string;
  model: string;
  prompt_name: string;
  prompt_version: number;
  rubric_version: string;
  grade_version: string;
  normalized_score: string | number | null;
  result: ItemResult | null;
  unscorable_reason: UnscorableReason | null;
  blocked_stage: "prompt" | "response" | null;
  status_detail: string | null;
  feedback_text: string | null;
  next_step: string | null;
  instruction_attempt: boolean;
  cost_usd: string | number | null;
  latency_ms: number;
  created_at: Date | string;
}

/**
 * The shape an `AiVerdict` takes in the database.
 *
 * Written as one function so the three statuses are mapped in one place: a
 * second mapping somewhere else is how `blocked_by_safety` eventually becomes
 * a zero.
 */
function toColumns(verdict: AiVerdict): {
  status: VerdictStatus;
  normalizedScore: number | null;
  result: ItemResult | null;
  unscorableReason: UnscorableReason | null;
  blockedStage: "prompt" | "response" | null;
  statusDetail: string | null;
  feedbackText: string | null;
  nextStep: string | null;
  instructionAttempt: boolean;
} {
  switch (verdict.status) {
    case "graded":
      return {
        status: "graded",
        normalizedScore: verdict.normalizedScore,
        result: verdict.result,
        unscorableReason: null,
        blockedStage: null,
        statusDetail: null,
        feedbackText: verdict.feedbackToLearner,
        nextStep: verdict.nextStep,
        instructionAttempt: verdict.instructionAttempt,
      };
    case "blocked_by_safety":
      return {
        status: "blocked_by_safety",
        normalizedScore: null,
        result: null,
        unscorableReason: null,
        blockedStage: verdict.stage,
        statusDetail: verdict.reason,
        feedbackText: null,
        nextStep: null,
        instructionAttempt: false,
      };
    case "unscorable":
      return {
        status: "unscorable",
        normalizedScore: null,
        result: null,
        unscorableReason: verdict.reason,
        blockedStage: null,
        statusDetail: verdict.detail,
        feedbackText: null,
        nextStep: null,
        instructionAttempt: false,
      };
  }
}

const VERDICT_COLUMNS = `
  v.id, v.verdict_status, v.learner_id, v.subject_type, v.subject_id, v.item_id,
  v.attempt_number, v.correlation_id, v.model, v.prompt_name, v.prompt_version,
  v.rubric_version, v.grade_version, v.normalized_score, v.result,
  v.unscorable_reason, v.blocked_stage, v.status_detail, v.feedback_text,
  v.next_step, v.instruction_attempt, v.cost_usd, v.latency_ms, v.created_at`;

export class SqlVerdictStore implements VerdictStore {
  constructor(private readonly sql: SqlExecutor) {}

  /**
   * Write one verdict and its per-skill criteria.
   *
   * One statement, so a crash between the two inserts cannot leave a graded
   * verdict with no levels — which would read as a legitimate score of zero.
   * The `unnest` form also means the criterion count does not change the
   * statement text, so the plan is cached across calls.
   */
  async save(input: SaveVerdictInput): Promise<StoredVerdict> {
    const verdict = input.verdict;
    const mapped = toColumns(verdict);
    const id = input.id ?? uuidv7();
    const criteria = verdict.status === "graded" ? verdict.criteria : [];

    const { rows } = await this.sql.query<VerdictRow>(
      `WITH inserted AS (
         INSERT INTO app.ai_verdict (
           id, subject_type, subject_id, learner_id, rubric_version_id,
           item_id, attempt_number,
           model, prompt_name, prompt_version, rubric_version, grade_version,
           input_snapshot, redaction_version,
           verdict_status, normalized_score, result, unscorable_reason,
           blocked_stage, status_detail, feedback_text, next_step,
           instruction_attempt, latency_ms, cost_usd,
           langfuse_trace_id, correlation_id
         )
         SELECT
           $1::uuid, $2::text, $3::uuid, $4::uuid, $5::uuid,
           $6::uuid, $7::int,
           $8::text, $9::text, $10::int, $11::text, $12::text,
           $13::jsonb, $14::text,
           $15::text, $16::numeric, $17::text, $18::text,
           $19::text, $20::text, $21::text, $22::text,
           $23::boolean, $24::int, $25::numeric,
           $26::uuid, $26::uuid
         -- Consent is a write-time constraint, the same way it is on the
         -- behaviour pipe: a verdict for a learner with no ai_grading grant
         -- is not stored and filtered later, it is never stored.
         WHERE app.has_consent($4::uuid, $32::text)
         RETURNING *
       ),
       criteria AS (
         -- FROM inserted rather than $1 so the criteria are skipped too
         -- when the consent gate above refused the verdict.
         INSERT INTO app.ai_verdict_criterion (verdict_id, skill_code, level, weight, reason, evidence)
         SELECT i.id, c.skill_code, c.level, c.weight, c.reason, c.evidence
         FROM inserted i,
              unnest($27::text[], $28::int[], $29::numeric[], $30::text[], $31::text[])
                AS c(skill_code, level, weight, reason, evidence)
         RETURNING 1
       )
       SELECT ${VERDICT_COLUMNS} FROM inserted v`,
      [
        id,
        input.subjectType,
        input.subjectId,
        input.learnerId,
        input.rubricVersionId ?? null,
        verdict.itemId,
        input.attemptNumber,
        verdict.model,
        verdict.promptName,
        verdict.promptVersion,
        verdict.rubricVersion,
        verdict.gradeVersion,
        JSON.stringify(input.inputSnapshot ?? null),
        input.redactionVersion,
        mapped.status,
        mapped.normalizedScore,
        mapped.result,
        mapped.unscorableReason,
        mapped.blockedStage,
        mapped.statusDetail,
        mapped.feedbackText,
        mapped.nextStep,
        mapped.instructionAttempt,
        verdict.latencyMs,
        verdict.costUsd,
        input.correlationId,
        criteria.map((c) => c.skillCode),
        criteria.map((c) => c.level),
        criteria.map((c) => c.weight),
        criteria.map((c) => c.reason),
        criteria.map((c) => c.evidence),
        VERDICT_CONSENT_SCOPE,
      ],
    );

    const row = rows[0];
    // The only way the INSERT returns nothing is the consent gate in its WHERE.
    if (!row) throw new ConsentMissing(input.learnerId);

    return {
      ...toStoredVerdict(row),
      criteria: criteria.map((c) => ({
        skillCode: c.skillCode,
        level: c.level,
        weight: c.weight,
        reason: c.reason,
        evidence: c.evidence,
      })),
    };
  }

  /**
   * Record one teacher correction, for one skill.
   *
   * `original_level` is selected out of `app.ai_verdict_criterion` inside the
   * INSERT rather than taken from the request body. A client that sent the
   * wrong "original" would otherwise write a training example claiming the AI
   * said something it never said — and nothing downstream could tell.
   *
   * The teacher's role comes from `identity.user_account` the same way. The
   * join filters on it so a guardian's id produces no row and a typed
   * `OverrideRejected("not_a_teacher")` rather than a raw constraint error the
   * endpoint would have to parse. The CHECK on `teacher_role` and the composite
   * foreign key on `(teacher_user_id, teacher_role)` stay underneath as the
   * structural backstop for any future writer that does not come through here.
   */
  async recordOverride(input: TeacherOverrideInput): Promise<TeacherOverride> {
    const id = input.id ?? uuidv7();

    const { rows } = await this.sql.query<{
      id: string;
      ai_verdict_id: string;
      skill_code: string;
      original_level: number;
      corrected_level: number;
      reason_code: CorrectionReasonCode;
      note: string | null;
      created_at: Date | string;
    }>(
      `INSERT INTO app.teacher_correction (
         id, ai_verdict_id, teacher_user_id, teacher_role, skill_code,
         original_level, corrected_level, reason_code, note, corrected_feedback
       )
       SELECT $1::uuid, c.verdict_id, u.id, u.role, c.skill_code,
              c.level, $4::int, $5::text, $6::text, $7::text
       FROM app.ai_verdict_criterion c
       JOIN identity.user_account u
         ON u.id = $3::uuid AND u.role IN ('teacher', 'admin') AND u.deleted_at IS NULL
       WHERE c.verdict_id = $2::uuid AND c.skill_code = $8::text
       RETURNING id, ai_verdict_id, skill_code, original_level, corrected_level,
                 reason_code, note, created_at`,
      [
        id,
        input.verdictId,
        input.teacherUserId,
        input.correctedLevel,
        input.reasonCode,
        input.note ?? null,
        input.correctedFeedback ?? null,
        input.skillCode,
      ],
    );

    const row = rows[0];
    if (!row) throw new OverrideRejected(await this.diagnoseOverride(input));

    return {
      id: row.id,
      verdictId: row.ai_verdict_id,
      skillCode: row.skill_code,
      originalLevel: row.original_level as RubricLevel,
      correctedLevel: row.corrected_level as RubricLevel,
      reasonCode: row.reason_code,
      note: row.note,
      createdAt: iso(row.created_at),
    };
  }

  /**
   * Why the INSERT matched no rows.
   *
   * Only reached on the failure path, so the extra round trip costs nothing in
   * the normal case, and it is what lets the endpoint answer 404 for an unknown
   * verdict and 403 for an adult who is not a teacher instead of one
   * uninformative 400.
   */
  private async diagnoseOverride(input: TeacherOverrideInput): Promise<OverrideFailure> {
    const { rows } = await this.sql.query<{
      verdict_exists: boolean;
      skill_exists: boolean;
      is_teacher: boolean;
    }>(
      `SELECT
         EXISTS (SELECT 1 FROM app.ai_verdict WHERE id = $1::uuid) AS verdict_exists,
         EXISTS (SELECT 1 FROM app.ai_verdict_criterion
                 WHERE verdict_id = $1::uuid AND skill_code = $3::text) AS skill_exists,
         EXISTS (SELECT 1 FROM identity.user_account
                 WHERE id = $2::uuid AND role IN ('teacher', 'admin')) AS is_teacher`,
      [input.verdictId, input.teacherUserId, input.skillCode],
    );

    const row = rows[0];
    if (!row?.is_teacher) return "not_a_teacher";
    if (!row.verdict_exists) return "unknown_verdict";
    return "unknown_skill";
  }

  async getEffective(verdictId: string): Promise<EffectiveVerdict | null> {
    const { rows } = await this.sql.query<VerdictRow>(
      `SELECT ${VERDICT_COLUMNS} FROM app.ai_verdict v WHERE v.id = $1::uuid`,
      [verdictId],
    );
    const row = rows[0];
    return row ? this.withCorrections(row) : null;
  }

  /**
   * The newest verdict for one piece of work.
   *
   * `ORDER BY created_at DESC, id DESC` rather than "the one row": a re-grade
   * is a new row by design, so there can legitimately be several, and the id
   * tiebreak keeps the answer stable when two land in the same millisecond.
   */
  async latestForSubject(
    subjectType: VerdictSubjectType,
    subjectId: string,
  ): Promise<EffectiveVerdict | null> {
    const { rows } = await this.sql.query<VerdictRow>(
      `SELECT ${VERDICT_COLUMNS}
       FROM app.ai_verdict v
       WHERE v.subject_type = $1::text AND v.subject_id = $2::uuid
       ORDER BY v.created_at DESC, v.id DESC
       LIMIT 1`,
      [subjectType, subjectId],
    );
    const row = rows[0];
    return row ? this.withCorrections(row) : null;
  }

  async latestForLearnerSubject(
    learnerId: string,
    subjectType: VerdictSubjectType,
    subjectId: string,
  ): Promise<EffectiveVerdict | null> {
    const { rows } = await this.sql.query<VerdictRow>(
      `SELECT ${VERDICT_COLUMNS}
       FROM app.ai_verdict v
       WHERE v.learner_id = $1::uuid
         AND v.subject_type = $2::text
         AND v.subject_id = $3::uuid
       ORDER BY v.created_at DESC, v.id DESC
       LIMIT 1`,
      [learnerId, subjectType, subjectId],
    );
    const row = rows[0];
    return row ? this.withCorrections(row) : null;
  }

  async listOverrides(verdictId: string): Promise<readonly TeacherOverride[]> {
    const { rows } = await this.sql.query<{
      id: string;
      ai_verdict_id: string;
      skill_code: string;
      original_level: number;
      corrected_level: number;
      reason_code: CorrectionReasonCode;
      note: string | null;
      created_at: Date | string;
    }>(
      `SELECT id, ai_verdict_id, skill_code, original_level, corrected_level,
              reason_code, note, created_at
       FROM app.teacher_correction
       WHERE ai_verdict_id = $1::uuid
       ORDER BY created_at ASC, id ASC`,
      [verdictId],
    );

    return rows.map((row) => ({
      id: row.id,
      verdictId: row.ai_verdict_id,
      skillCode: row.skill_code,
      originalLevel: row.original_level as RubricLevel,
      correctedLevel: row.corrected_level as RubricLevel,
      reasonCode: row.reason_code,
      note: row.note,
      createdAt: iso(row.created_at),
    }));
  }

  /**
   * Apply teacher corrections to one verdict.
   *
   * The per-skill levels and the corrected total both come from
   * `app.criterion_effective` / `app.score_effective`, so the rule "a teacher
   * beats the model" is applied by the view every reader shares rather than by
   * whichever caller remembered to. The correct/partial band is computed here
   * with `toResultBand`, because `RESULT_THRESHOLDS` is the single definition
   * of where those lines fall and duplicating it in SQL would let the two drift.
   */
  private async withCorrections(row: VerdictRow): Promise<EffectiveVerdict> {
    const base = toStoredVerdict(row);

    if (base.status !== "graded") {
      return {
        verdictId: base.id,
        status: base.status,
        itemId: base.itemId,
        attemptNumber: base.attemptNumber,
        correlationId: base.correlationId,
        feedbackToLearner: null,
        nextStep: null,
        statusDetail: base.statusDetail,
        unscorableReason: base.unscorableReason,
        aiNormalizedScore: null,
        normalizedScore: null,
        result: null,
        teacherCorrected: false,
        correctedSkillCount: 0,
        criteria: [],
        createdAt: base.createdAt,
      };
    }

    const [criteria, totals] = await Promise.all([
      this.sql.query<{
        skill_code: string;
        weight: string | number;
        ai_level: number;
        level: number;
        teacher_corrected: boolean;
        reason: string;
        evidence: string | null;
      }>(
        `SELECT skill_code, weight, ai_level, level, teacher_corrected, reason, evidence
         FROM app.criterion_effective
         WHERE verdict_id = $1::uuid
         ORDER BY skill_code`,
        [row.id],
      ),
      this.sql.query<{
        normalized_score: string | number | null;
        teacher_corrected: boolean;
        corrected_skill_count: string | number;
      }>(
        `SELECT normalized_score, teacher_corrected, corrected_skill_count
         FROM app.score_effective
         WHERE verdict_id = $1::uuid`,
        [row.id],
      ),
    ]);

    const total = totals.rows[0];
    const normalizedScore = maybeNum(total?.normalized_score);

    return {
      verdictId: base.id,
      status: "graded",
      itemId: base.itemId,
      attemptNumber: base.attemptNumber,
      correlationId: base.correlationId,
      feedbackToLearner: base.feedbackToLearner,
      nextStep: base.nextStep,
      statusDetail: null,
      unscorableReason: null,
      aiNormalizedScore: base.normalizedScore,
      normalizedScore,
      result: normalizedScore === null ? null : toResultBand(normalizedScore),
      teacherCorrected: total?.teacher_corrected ?? false,
      correctedSkillCount: Number(total?.corrected_skill_count ?? 0),
      criteria: criteria.rows.map((c) => ({
        skillCode: c.skill_code,
        weight: num(c.weight, 0),
        aiLevel: c.ai_level as RubricLevel,
        level: c.level as RubricLevel,
        teacherCorrected: c.teacher_corrected,
        reason: c.reason,
        evidence: c.evidence,
      })),
      createdAt: base.createdAt,
    };
  }
}

function toStoredVerdict(row: VerdictRow): Omit<StoredVerdict, "criteria"> {
  return {
    id: row.id,
    status: row.verdict_status,
    learnerId: row.learner_id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    itemId: row.item_id,
    attemptNumber: row.attempt_number,
    correlationId: row.correlation_id,
    model: row.model,
    promptName: row.prompt_name,
    promptVersion: row.prompt_version,
    rubricVersion: row.rubric_version,
    gradeVersion: row.grade_version,
    normalizedScore: maybeNum(row.normalized_score),
    result: row.result,
    unscorableReason: row.unscorable_reason,
    blockedStage: row.blocked_stage,
    statusDetail: row.status_detail,
    feedbackToLearner: row.feedback_text,
    nextStep: row.next_step,
    instructionAttempt: row.instruction_attempt,
    costUsd: maybeNum(row.cost_usd),
    latencyMs: row.latency_ms,
    createdAt: iso(row.created_at),
  };
}
