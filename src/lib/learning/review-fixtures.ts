/**
 * Three verdicts to look at the teacher review screens with (PRO-77).
 *
 * The screens exist to keep three outcomes apart — a score, a refusal, and an
 * answer the model could not judge — and the only way to check that they do is
 * to have one of each in front of you. Nothing calls `SqlVerdictStore.save()`
 * in the product yet (the grading engine from PRO-8 is not wired to a request
 * path), so until it is, this is where the rows come from on a laptop.
 *
 * Two rules this file follows deliberately:
 *
 *   - **it writes through `SqlVerdictStore.save()`**, not through hand-written
 *     INSERTs. Every CHECK constraint that keeps `blocked_by_safety` from
 *     acquiring a score therefore applies to these rows too, so a screen that
 *     renders them is reading the same shape production will hand it.
 *   - **it runs only behind `STEAMKID_DEV_DB=pglite`**, in a throwaway
 *     in-memory database, and every screen it feeds carries the demo banner.
 *     No fixture ever reaches a deployed tier.
 *
 * No real child exists in this repository. Every answer below was invented.
 */

import { getItemById, isWrittenItem } from "@/content";
import type { SqlExecutor } from "@/lib/db/sql";
import { uuidv7 } from "@/lib/ids";

import { GRADE_VERSION, GRADING_PROMPTS, toResultBand, weightedScore } from "./ai-grade";
import type { AiVerdict, GradedCriterion } from "./ai-grade";
import { rubricVersionTag, RUBRICS, type WrittenSkillCode } from "./rubric";
import { SqlVerdictStore, VERDICT_CONSENT_SCOPE } from "./verdict-store";

/** A short-answer item from the seeded course, used by all three fixtures. */
const SHORT_ITEM_ID = "5a53bf55-c0f8-5f3b-9278-6bf3ae94ffe8";
/** A long-answer item, so the queue shows more than one piece of work. */
const LONG_ITEM_ID = "1219792e-b78d-57dc-a9ee-320253a213d3";

const REDACTION_VERSION = "redact@1";
const DEMO_MODEL = "gemini-3.8-flash";

export interface SeededReviewDemo {
  /** `identity.user_account.id` with role `teacher`, for the `sk_teacher` cookie. */
  readonly teacherUserId: string;
  readonly verdictIds: readonly string[];
}

async function rubricVersionFor(itemId: string): Promise<string> {
  const found = await getItemById(itemId);
  if (!found || !isWrittenItem(found.item)) {
    throw new Error(`review fixture: ${itemId} is not a written item in src/content`);
  }
  return rubricVersionTag(RUBRICS[found.item.rubricCode as keyof typeof RUBRICS]);
}

async function promptNameFor(itemId: string): Promise<string> {
  const found = await getItemById(itemId);
  if (!found || !isWrittenItem(found.item)) {
    throw new Error(`review fixture: ${itemId} is not a written item in src/content`);
  }
  return GRADING_PROMPTS[found.item.rubricCode] ?? "grading/unknown";
}

interface Base {
  readonly itemId: string;
  readonly rubricVersion: string;
  readonly promptName: string;
}

async function base(itemId: string): Promise<Base> {
  return {
    itemId,
    rubricVersion: await rubricVersionFor(itemId),
    promptName: await promptNameFor(itemId),
  };
}

function shared(b: Base, latencyMs: number) {
  return {
    itemId: b.itemId,
    rubricVersion: b.rubricVersion,
    gradeVersion: GRADE_VERSION,
    model: DEMO_MODEL,
    promptName: b.promptName,
    promptVersion: 1,
    // Null on purpose: a local checkout has no Langfuse project, and a fixture
    // that invented a trace url would send a teacher to a 404 and teach them
    // the link is not worth clicking.
    traceId: null,
    traceUrl: null,
    costUsd: 0.000_21,
    latencyMs,
  } as const;
}

/**
 * The graded case: two skills the model was confident about, one it was harsh
 * on. `SCI.HYPOTHESIS` at level 0 is the row a teacher is most likely to
 * disagree with, which is the point of having it here.
 */
async function gradedVerdict(): Promise<AiVerdict> {
  const b = await base(SHORT_ITEM_ID);
  const criteria: readonly GradedCriterion[] = [
    {
      skillCode: "SCI.EXPLAIN_EVIDENCE" as WrittenSkillCode,
      level: 2,
      weight: 0.7,
      reason:
        "ยกสิ่งที่สังเกตเห็นมาหนึ่งอย่าง (กล่องเลื่อนไปข้างหน้า) แต่ยังไม่ได้บอกว่าหลักฐานนั้นแปลว่ามีแรงมากระทำอย่างไร",
      evidence: "เมื่อก่อนกล่องอยู่เฉย ๆ แล้วตอนนี้มันเลื่อนไปแล้ว",
    },
    {
      skillCode: "COMM.SCI_WRITING" as WrittenSkillCode,
      level: 2,
      weight: 0.3,
      reason: "เรียงความคิดได้เป็นลำดับ อ่านแล้วตามได้ แต่ประโยคสุดท้ายยังห้วน",
      evidence: "ก็เลยแปลว่ามีอะไรมาผลักมัน",
    },
  ];

  const normalizedScore = weightedScore(criteria);

  return {
    ...shared(b, 2_140),
    status: "graded",
    criteria,
    normalizedScore,
    result: toResultBand(normalizedScore),
    feedbackToLearner:
      "หนูสังเกตเก่งมาก ที่บอกว่ากล่องเคยอยู่เฉย ๆ แล้วตอนนี้เลื่อนไปแล้ว นั่นคือหลักฐานที่ดีเลย",
    nextStep: "ลองเติมอีกประโยคว่า “สิ่งที่หนูเห็นแปลว่ามีแรงมาผลักกล่อง เพราะ…”",
    instructionAttempt: false,
  };
}

/**
 * The refusal case. There is no score, no criteria and no text for the child —
 * enforced by the CHECK constraints, not by this fixture being careful — so a
 * screen that renders this as "0 คะแนน" is visibly wrong.
 */
async function blockedVerdict(): Promise<AiVerdict> {
  const b = await base(LONG_ITEM_ID);
  return {
    ...shared(b, 890),
    status: "blocked_by_safety",
    stage: "response",
    reason:
      "โมเดลหยุดกลางคัน: เด็กเล่าเหตุการณ์ที่มีคนในบ้านเจ็บตัว ตัวกรองความปลอดภัยจึงไม่คืนผลการตรวจ",
  };
}

/** The "cannot judge this" case: a real answer, too short to score. */
async function unscorableVerdict(): Promise<AiVerdict> {
  const b = await base(SHORT_ITEM_ID);
  return {
    ...shared(b, 640),
    status: "unscorable",
    reason: "too_short",
    detail: "คำตอบมี 11 ตัวอักษร ต่ำกว่าเกณฑ์ขั้นต่ำ 20 ตัวอักษรของข้อนี้",
  };
}

/** What each fixture verdict was grading, as `input_snapshot` stores it. */
const ANSWERS: Record<"graded" | "blocked" | "unscorable", string> = {
  graded:
    "เมื่อก่อนกล่องอยู่เฉย ๆ แล้วตอนนี้มันเลื่อนไปแล้ว ก็เลยแปลว่ามีอะไรมาผลักมัน",
  blocked:
    "วันนี้หนูช่วยแม่ยกโต๊ะ แล้วโต๊ะหล่นใส่เท้าพี่ชาย พี่ร้องไห้เลย หนูออกแรงดึงโต๊ะขึ้นมา",
  unscorable: "มีแรงค่ะ",
};

/**
 * Seed one guardian, their consent, a teacher, and the three verdicts.
 *
 * `ai_grading` consent is not optional scaffolding: `SqlVerdictStore.save()`
 * gates on `app.has_consent` inside the INSERT, so without it the fixture
 * silently stores nothing and the queue renders empty. That gate firing here is
 * the same gate protecting a real child.
 */
export async function seedReviewDemo(
  sql: SqlExecutor,
  learnerId: string,
): Promise<SeededReviewDemo> {
  const guardianUserId = uuidv7();
  const teacherUserId = uuidv7();

  await sql.query(
    `INSERT INTO identity.user_account (id, role, email, auth_provider, auth_subject_id, display_name)
     VALUES ($1::uuid, 'guardian', $2, 'fixture', $3, 'ผู้ปกครองตัวอย่าง')`,
    [guardianUserId, `guardian-${guardianUserId}@example.invalid`, `fixture:${guardianUserId}`],
  );
  await sql.query(
    `INSERT INTO identity.user_account (id, role, email, auth_provider, auth_subject_id, display_name)
     VALUES ($1::uuid, 'teacher', $2, 'fixture', $3, 'ครูตัวอย่าง')`,
    [teacherUserId, `teacher-${teacherUserId}@example.invalid`, `fixture:${teacherUserId}`],
  );
  await sql.query(
    `INSERT INTO app.guardian_link (guardian_user_id, learner_id, relationship, verified_at)
     VALUES ($1::uuid, $2::uuid, 'parent', now())`,
    [guardianUserId, learnerId],
  );
  await sql.query(
    `INSERT INTO app.consent_record
       (id, learner_id, guardian_user_id, policy_version, scope, granted, method, evidence)
     VALUES ($1::uuid, $2::uuid, $3::uuid, '2026-09-19.1', $4, true,
             'guardian_web_verified_email', $5::jsonb)`,
    [
      uuidv7(),
      learnerId,
      guardianUserId,
      VERDICT_CONSENT_SCOPE,
      JSON.stringify({ ip_hash: "fixture-ip-hash", ua_hash: "fixture-ua-hash", ui_version: "1" }),
    ],
  );

  const store = new SqlVerdictStore(sql);
  const plan = [
    { verdict: await unscorableVerdict(), answer: ANSWERS.unscorable, attempt: 1 },
    { verdict: await blockedVerdict(), answer: ANSWERS.blocked, attempt: 1 },
    { verdict: await gradedVerdict(), answer: ANSWERS.graded, attempt: 2 },
  ];

  const verdictIds: string[] = [];
  for (const entry of plan) {
    const correlationId = uuidv7();
    const stored = await store.save({
      verdict: entry.verdict,
      learnerId,
      subjectType: "attempt",
      subjectId: uuidv7(),
      attemptNumber: entry.attempt,
      correlationId,
      // `answer` is the key the review screen reads first. When the grading
      // call is finally wired to `save()`, write the redacted learner text
      // under the same key or the teacher screen shows raw JSON.
      inputSnapshot: { answer: entry.answer, itemId: entry.verdict.itemId },
      redactionVersion: REDACTION_VERSION,
    });
    verdictIds.push(stored.id);
  }

  return { teacherUserId, verdictIds };
}
