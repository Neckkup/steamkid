/**
 * The verdict store, against the migrations a deploy actually applies.
 *
 * PGlite rather than a mock, for the reason `pg-sink.test.ts` gives: the rules
 * this file is about — "a refusal has no score", "a correction is a new row",
 * "only a teacher may correct" — are CHECK constraints, triggers and a
 * composite foreign key. A mocked client enforces none of them, so a test
 * against one would pass while the schema quietly did not hold.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/lib/db/test-database";
import { uuidv7 } from "@/lib/ids";

import { GRADE_VERSION, weightedScore, type AiVerdict } from "./ai-grade";
import {
  OverrideRejected,
  SqlVerdictStore,
  type SaveVerdictInput,
} from "./verdict-store";

let db: TestDatabase;
let store: SqlVerdictStore;

let learnerId: string;
let teacherId: string;
let guardianId: string;
let subjectId: string;
let itemId: string;

const REDACTION_VERSION = "redact@1";

/** A graded verdict with two skills, one heavier than the other. */
function gradedVerdict(overrides: Partial<Extract<AiVerdict, { status: "graded" }>> = {}): AiVerdict {
  return {
    itemId,
    rubricVersion: "SCI_CER_SHORT@1",
    gradeVersion: GRADE_VERSION,
    model: "gemini-3.8-flash",
    promptName: "grading/sci-cer-short",
    promptVersion: 1,
    traceId: null,
    traceUrl: null,
    costUsd: 0.003547,
    latencyMs: 4257,
    status: "graded",
    criteria: [
      {
        skillCode: "SCI.HYPOTHESIS",
        level: 2,
        weight: 0.6,
        reason: "ตั้งคำทำนายชัด แต่ไม่ได้บอกว่าผลแบบไหนจะแปลว่าผิด",
        evidence: "ฉันคิดว่าลูกบอลจะตกเร็วกว่า",
      },
      {
        skillCode: "COMM.SCI_WRITING",
        level: 3,
        weight: 0.4,
        reason: "เรียบเรียงเป็นลำดับ อ่านเข้าใจ",
        evidence: null,
      },
    ],
    normalizedScore: weightedScore([
      { skillCode: "SCI.HYPOTHESIS", level: 2, weight: 0.6, reason: "", evidence: null },
      { skillCode: "COMM.SCI_WRITING", level: 3, weight: 0.4, reason: "", evidence: null },
    ]),
    result: "partial",
    feedbackToLearner: "เขียนได้ดีมาก ลองบอกด้วยว่าผลแบบไหนจะแปลว่าคำทำนายผิด",
    nextStep: "เขียนเพิ่มหนึ่งประโยคว่า ถ้าเห็นอะไรแปลว่าคิดผิด",
    instructionAttempt: false,
    ...overrides,
  } as AiVerdict;
}

const blockedVerdict = (): AiVerdict => ({
  itemId,
  rubricVersion: "SCI_CER_SHORT@1",
  gradeVersion: GRADE_VERSION,
  model: "gemini-3.8-flash",
  promptName: "grading/sci-cer-short",
  promptVersion: 0,
  traceId: null,
  traceUrl: null,
  costUsd: null,
  latencyMs: 0,
  status: "blocked_by_safety",
  reason: "SAFETY: HARM_CATEGORY_DANGEROUS_CONTENT",
  stage: "response",
});

const unscorableVerdict = (): AiVerdict => ({
  itemId,
  rubricVersion: "SCI_CER_SHORT@1",
  gradeVersion: GRADE_VERSION,
  model: "gemini-3.8-flash",
  promptName: "grading/sci-cer-short",
  promptVersion: 1,
  traceId: null,
  traceUrl: null,
  costUsd: 0.0001,
  latencyMs: 812,
  status: "unscorable",
  reason: "too_short",
  detail: "จำไม่ได้แล้วว่าคิดอะไรไว้",
});

function saveInput(verdict: AiVerdict): SaveVerdictInput {
  return {
    verdict,
    learnerId,
    subjectType: "attempt",
    subjectId,
    attemptNumber: 1,
    correlationId: uuidv7(),
    inputSnapshot: { learnerAnswer: "[REDACTED]" },
    redactionVersion: REDACTION_VERSION,
  };
}

beforeAll(async () => {
  db = await createTestDatabase();
  store = new SqlVerdictStore(db);
}, 120_000);

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  // A fresh learner, teacher and attempt per test, because every table under
  // test is append-only — there is no cleaning up, only new rows.
  learnerId = uuidv7();
  teacherId = uuidv7();
  guardianId = uuidv7();
  subjectId = uuidv7();
  itemId = uuidv7();

  await db.query(
    `INSERT INTO app.learner (id, public_ref, grade_band) VALUES ($1, $2, 'p5')`,
    [learnerId, uuidv7()],
  );
  await db.query(
    `INSERT INTO identity.user_account (id, role, email, auth_provider, auth_subject_id)
     VALUES ($1::uuid, 'teacher', $2, 'test', $1::text)`,
    [teacherId, `teacher-${teacherId}@example.test`],
  );
  await db.query(
    `INSERT INTO identity.user_account (id, role, email, auth_provider, auth_subject_id)
     VALUES ($1::uuid, 'guardian', $2, 'test', $1::text)`,
    [guardianId, `guardian-${guardianId}@example.test`],
  );
  await grantAiGrading(learnerId, guardianId);
});

/** A guardian saying yes to AI grading. Without it nothing may be stored. */
async function grantAiGrading(learner: string, guardian: string): Promise<void> {
  await db.query(
    `INSERT INTO app.consent_record
       (id, learner_id, guardian_user_id, policy_version, scope, granted, method, evidence)
     VALUES ($1, $2, $3, 'v1', 'ai_grading', true, 'guardian_web_verified_email', '{}')`,
    [uuidv7(), learner, guardian],
  );
}

describe("storing a verdict", () => {
  it("keeps a graded verdict, its score and every criterion", async () => {
    const stored = await store.save(saveInput(gradedVerdict()));

    const read = await store.getEffective(stored.id);
    expect(read?.status).toBe("graded");
    expect(read?.normalizedScore).toBeCloseTo(0.8, 10);
    expect(read?.criteria.map((c) => [c.skillCode, c.level])).toEqual([
      ["COMM.SCI_WRITING", 3],
      ["SCI.HYPOTHESIS", 2],
    ]);
    expect(read?.criteria.find((c) => c.skillCode === "SCI.HYPOTHESIS")?.evidence).toBe(
      "ฉันคิดว่าลูกบอลจะตกเร็วกว่า",
    );
  });

  it("stores the score the engine computed, not one SQL reinvented", async () => {
    // `app.score_effective` recomputes the weighted mean in SQL so a teacher
    // correction changes the total. If that formula and `weightedScore()` ever
    // disagree, a child's score moves the moment a teacher opens the screen.
    const verdict = gradedVerdict();
    const stored = await store.save(saveInput(verdict));
    const read = await store.getEffective(stored.id);

    expect(verdict.status).toBe("graded");
    expect(read?.aiNormalizedScore).toBeCloseTo(
      (verdict as Extract<AiVerdict, { status: "graded" }>).normalizedScore,
      10,
    );
    expect(read?.normalizedScore).toBeCloseTo(read!.aiNormalizedScore!, 10);
  });

  it("stores a safety block as a block, with no score at all", async () => {
    const stored = await store.save(saveInput(blockedVerdict()));

    expect(stored.status).toBe("blocked_by_safety");
    expect(stored.normalizedScore).toBeNull();
    expect(stored.blockedStage).toBe("response");

    const read = await store.getEffective(stored.id);
    expect(read?.status).toBe("blocked_by_safety");
    expect(read?.normalizedScore).toBeNull();
    expect(read?.result).toBeNull();
    expect(read?.statusDetail).toContain("SAFETY");
  });

  it("stores an unscorable answer with its named reason", async () => {
    const stored = await store.save(saveInput(unscorableVerdict()));

    expect(stored.status).toBe("unscorable");
    expect(stored.unscorableReason).toBe("too_short");
    expect(stored.normalizedScore).toBeNull();

    const read = await store.getEffective(stored.id);
    expect(read?.unscorableReason).toBe("too_short");
    expect(read?.normalizedScore).toBeNull();
  });

  /**
   * The failure this whole ticket is against: a blocked verdict reaching a
   * child as a zero. The database refuses it, so no future caller can do it by
   * being careless with a nullable column.
   */
  it("refuses a score on a verdict that was never graded", async () => {
    await expect(
      db.query(
        `INSERT INTO app.ai_verdict (
           id, subject_type, subject_id, learner_id, item_id, attempt_number,
           model, prompt_name, prompt_version, rubric_version, grade_version,
           input_snapshot, redaction_version, verdict_status, blocked_stage,
           normalized_score, latency_ms, langfuse_trace_id, correlation_id)
         VALUES ($1, 'attempt', $2, $3, $4, 1, 'gemini-3.8-flash', 'p', 1,
                 'r@1', 'ai-grade@1', '{}', $5, 'blocked_by_safety', 'response',
                 0, 10, $6, $6)`,
        [uuidv7(), subjectId, learnerId, itemId, REDACTION_VERSION, uuidv7()],
      ),
    ).rejects.toThrow(/ai_verdict_score_only_when_graded/);
  });

  it("refuses per-skill levels on a verdict that was never graded", async () => {
    const stored = await store.save(saveInput(blockedVerdict()));

    await expect(
      db.query(
        `INSERT INTO app.ai_verdict_criterion (verdict_id, skill_code, level, weight, reason)
         VALUES ($1, 'SCI.HYPOTHESIS', 0, 1, 'invented')`,
        [stored.id],
      ),
    ).rejects.toThrow(/requires a graded verdict/);
  });

  /**
   * data-schema §5: one id ties the child's clicks, the API call and the
   * Langfuse trace. A verdict whose trace id drifted from its correlation id
   * cannot be joined back to what the child was doing, so it is rejected.
   */
  it("refuses a verdict whose trace id is not its correlation id", async () => {
    await expect(
      db.query(
        `INSERT INTO app.ai_verdict (
           id, subject_type, subject_id, learner_id, item_id, attempt_number,
           model, prompt_name, prompt_version, rubric_version, grade_version,
           input_snapshot, redaction_version, verdict_status, normalized_score,
           result, feedback_text, next_step, latency_ms, langfuse_trace_id, correlation_id)
         VALUES ($1, 'attempt', $2, $3, $4, 1, 'gemini-3.8-flash', 'p', 1,
                 'r@1', 'ai-grade@1', '{}', $5, 'graded', 0.8, 'correct', 'ok', 'next',
                 10, $6, $7)`,
        [uuidv7(), subjectId, learnerId, itemId, REDACTION_VERSION, uuidv7(), uuidv7()],
      ),
    ).rejects.toThrow(/ai_verdict_trace_is_correlation/);
  });

  it("refuses to rewrite a stored verdict", async () => {
    const stored = await store.save(saveInput(gradedVerdict()));

    await expect(
      db.query(`UPDATE app.ai_verdict SET normalized_score = 1 WHERE id = $1`, [stored.id]),
    ).rejects.toThrow(/append-only/);
  });
});

describe("a teacher correcting a verdict", () => {
  it("writes a new row and leaves the AI's level in place", async () => {
    const stored = await store.save(saveInput(gradedVerdict()));

    const override = await store.recordOverride({
      verdictId: stored.id,
      teacherUserId: teacherId,
      skillCode: "SCI.HYPOTHESIS",
      correctedLevel: 3,
      reasonCode: "too_harsh",
      note: "เด็กบอกเงื่อนไขที่จะแปลว่าผิดไว้ในประโยคถัดไป",
    });

    expect(override.originalLevel).toBe(2);
    expect(override.correctedLevel).toBe(3);

    // The AI's own row is untouched — the pair is the training example.
    const { rows } = await db.query<{ level: number }>(
      `SELECT level FROM app.ai_verdict_criterion
       WHERE verdict_id = $1 AND skill_code = 'SCI.HYPOTHESIS'`,
      [stored.id],
    );
    expect(rows[0]?.level).toBe(2);
  });

  it("keeps both corrections when a teacher changes their mind", async () => {
    const stored = await store.save(saveInput(gradedVerdict()));

    await store.recordOverride({
      verdictId: stored.id,
      teacherUserId: teacherId,
      skillCode: "SCI.HYPOTHESIS",
      correctedLevel: 3,
      reasonCode: "too_harsh",
    });
    await store.recordOverride({
      verdictId: stored.id,
      teacherUserId: teacherId,
      skillCode: "SCI.HYPOTHESIS",
      correctedLevel: 1,
      reasonCode: "too_lenient",
      note: "อ่านอีกรอบแล้วคิดว่าให้สูงไป",
    });

    const history = await store.listOverrides(stored.id);
    expect(history.map((o) => o.correctedLevel)).toEqual([3, 1]);
    // Both rows still say what the AI said, not what the previous teacher said.
    expect(history.map((o) => o.originalLevel)).toEqual([2, 2]);
  });

  it("makes the corrected level the one the child's summary reads", async () => {
    const stored = await store.save(saveInput(gradedVerdict()));
    const before = await store.getEffective(stored.id);

    await store.recordOverride({
      verdictId: stored.id,
      teacherUserId: teacherId,
      skillCode: "SCI.HYPOTHESIS",
      correctedLevel: 3,
      reasonCode: "too_harsh",
    });

    const after = await store.getEffective(stored.id);
    expect(after?.teacherCorrected).toBe(true);
    expect(after?.correctedSkillCount).toBe(1);
    // 0.6*3/3 + 0.4*3/3 = 1.0, up from 0.8.
    expect(after?.normalizedScore).toBeCloseTo(1, 10);
    expect(after?.result).toBe("correct");
    // The AI's figure is still available beside it.
    expect(after?.aiNormalizedScore).toBeCloseTo(before!.aiNormalizedScore!, 10);

    const corrected = after?.criteria.find((c) => c.skillCode === "SCI.HYPOTHESIS");
    expect(corrected?.level).toBe(3);
    expect(corrected?.aiLevel).toBe(2);
    expect(corrected?.teacherCorrected).toBe(true);

    // The skill nobody touched keeps the AI's level and is not marked corrected.
    const untouched = after?.criteria.find((c) => c.skillCode === "COMM.SCI_WRITING");
    expect(untouched?.level).toBe(3);
    expect(untouched?.teacherCorrected).toBe(false);
  });

  it("refuses a correction from an adult who is not a teacher", async () => {
    const stored = await store.save(saveInput(gradedVerdict()));

    await expect(
      store.recordOverride({
        verdictId: stored.id,
        teacherUserId: guardianId,
        skillCode: "SCI.HYPOTHESIS",
        correctedLevel: 3,
        reasonCode: "too_harsh",
      }),
    ).rejects.toThrow(/teacher_correction_role_values|not_a_teacher/);
  });

  it("names the reason a correction could not be written", async () => {
    const stored = await store.save(saveInput(gradedVerdict()));

    await expect(
      store.recordOverride({
        verdictId: stored.id,
        teacherUserId: teacherId,
        skillCode: "SCI.NOT_ON_THIS_ITEM",
        correctedLevel: 3,
        reasonCode: "other",
      }),
    ).rejects.toMatchObject({ failure: "unknown_skill" });

    await expect(
      store.recordOverride({
        verdictId: uuidv7(),
        teacherUserId: teacherId,
        skillCode: "SCI.HYPOTHESIS",
        correctedLevel: 3,
        reasonCode: "other",
      }),
    ).rejects.toBeInstanceOf(OverrideRejected);
  });

  it("refuses to rewrite a stored correction", async () => {
    const stored = await store.save(saveInput(gradedVerdict()));
    const override = await store.recordOverride({
      verdictId: stored.id,
      teacherUserId: teacherId,
      skillCode: "SCI.HYPOTHESIS",
      correctedLevel: 3,
      reasonCode: "too_harsh",
    });

    await expect(
      db.query(`UPDATE app.teacher_correction SET corrected_level = 0 WHERE id = $1`, [
        override.id,
      ]),
    ).rejects.toThrow(/append-only/);
  });
});

describe("reading back the newest verdict for one piece of work", () => {
  it("returns the re-grade, not the first attempt at grading it", async () => {
    const first = await store.save(saveInput(gradedVerdict()));
    const second = await store.save({
      ...saveInput(gradedVerdict({ normalizedScore: 1, result: "correct" })),
      attemptNumber: 2,
    });

    const latest = await store.latestForSubject("attempt", subjectId);
    expect(latest?.verdictId).toBe(second.id);
    expect(latest?.verdictId).not.toBe(first.id);
    expect(latest?.attemptNumber).toBe(2);
  });

  it("returns null when this work has never been graded", async () => {
    expect(await store.latestForSubject("attempt", uuidv7())).toBeNull();
  });

  /**
   * The read a child's own screen uses. Scoped by learner so that guessing a
   * submission id cannot show one child another child's grade — a property of
   * the statement, not of the caller remembering to filter.
   */
  it("will not hand one learner another learner's verdict", async () => {
    const stored = await store.save(saveInput(gradedVerdict()));
    const stranger = uuidv7();
    await db.query(`INSERT INTO app.learner (id, public_ref, grade_band) VALUES ($1, $2, 'p5')`, [
      stranger,
      uuidv7(),
    ]);

    expect(
      (await store.latestForLearnerSubject(learnerId, "attempt", subjectId))?.verdictId,
    ).toBe(stored.id);
    expect(await store.latestForLearnerSubject(stranger, "attempt", subjectId)).toBeNull();
  });
});

describe("consent as a write-time constraint", () => {
  /**
   * The grading call should never have happened without consent — `/api/attempts`
   * gates on it. If one slips through anyway, the verdict is not written: not
   * written and filtered later, never written, the same rule the behaviour pipe
   * follows.
   */
  it("refuses to store a verdict for a learner with no ai_grading consent", async () => {
    const unconsented = uuidv7();
    await db.query(`INSERT INTO app.learner (id, public_ref, grade_band) VALUES ($1, $2, 'p5')`, [
      unconsented,
      uuidv7(),
    ]);

    await expect(
      store.save({ ...saveInput(gradedVerdict()), learnerId: unconsented }),
    ).rejects.toMatchObject({ name: "ConsentMissing" });

    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM app.ai_verdict WHERE learner_id = $1`,
      [unconsented],
    );
    expect(rows[0]?.count).toBe("0");
  });

  it("refuses once consent is withdrawn, and leaves earlier verdicts alone", async () => {
    const stored = await store.save(saveInput(gradedVerdict()));

    // Withdrawal is a new row, never an edit of the old one.
    await db.query(
      `INSERT INTO app.consent_record
         (id, learner_id, guardian_user_id, policy_version, scope, granted, method, evidence)
       VALUES ($1, $2, $3, 'v1', 'ai_grading', false, 'guardian_web_verified_email', '{}')`,
      [uuidv7(), learnerId, guardianId],
    );

    await expect(store.save(saveInput(gradedVerdict()))).rejects.toMatchObject({
      name: "ConsentMissing",
    });
    // History is not rewritten by a withdrawal; it is a fact that happened.
    expect((await store.getEffective(stored.id))?.status).toBe("graded");
  });

  it("stores no criteria when the consent gate refuses the verdict", async () => {
    const unconsented = uuidv7();
    await db.query(`INSERT INTO app.learner (id, public_ref, grade_band) VALUES ($1, $2, 'p5')`, [
      unconsented,
      uuidv7(),
    ]);
    const id = uuidv7();

    await expect(
      store.save({ ...saveInput(gradedVerdict()), learnerId: unconsented, id }),
    ).rejects.toMatchObject({ name: "ConsentMissing" });

    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM app.ai_verdict_criterion WHERE verdict_id = $1`,
      [id],
    );
    expect(rows[0]?.count).toBe("0");
  });
});
