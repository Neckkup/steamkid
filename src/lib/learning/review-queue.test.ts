/**
 * What the teacher review screens read, against the real migrations.
 *
 * The three things worth pinning here are the three ways this screen could
 * quietly hurt a child:
 *
 *   1. a verdict the model refused must never arrive carrying a score
 *   2. the queue must put the children who got nothing back at the top
 *   3. a correction must survive a reload, with the AI's original still visible
 *
 * All three are properties of the SQL and the schema rather than of a
 * component, so they are tested against PGlite for the reason
 * `verdict-store.test.ts` gives: a mock would enforce none of the constraints
 * that make them true.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/lib/db/test-database";
import { uuidv7 } from "@/lib/ids";

import { seedGrowthLearner, seedSkillMap } from "@/lib/growth/fixtures";

import { answerText, SqlReviewQueue } from "./review-queue";
import { seedReviewDemo } from "./review-fixtures";
import { SqlVerdictStore } from "./verdict-store";

let db: TestDatabase;
let queue: SqlReviewQueue;
let store: SqlVerdictStore;
let learnerId: string;
let teacherUserId: string;

beforeAll(async () => {
  db = await createTestDatabase();
  queue = new SqlReviewQueue(db);
  store = new SqlVerdictStore(db);

  await seedSkillMap(db);
  const learner = await seedGrowthLearner(db, { displayName: "ใบตอง", profile: "ready" });
  learnerId = learner.learnerId;

  const seeded = await seedReviewDemo(db, learnerId);
  teacherUserId = seeded.teacherUserId;
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("the demo fixture", () => {
  it("stores one verdict of each status through the real store", async () => {
    const entries = await queue.list();
    expect(entries).toHaveLength(3);
    expect(new Set(entries.map((entry) => entry.status))).toEqual(
      new Set(["graded", "blocked_by_safety", "unscorable"]),
    );
  });

  it("gives the learner's nickname to the teacher surface", async () => {
    const entries = await queue.list();
    expect(entries.every((entry) => entry.learnerName === "ใบตอง")).toBe(true);
  });
});

describe("the queue order", () => {
  it("puts every verdict the AI produced no score for above the graded ones", async () => {
    const entries = await queue.list();
    const firstGraded = entries.findIndex((entry) => !entry.awaitingTeacher);
    const lastWaiting = entries.map((entry) => entry.awaitingTeacher).lastIndexOf(true);

    expect(firstGraded).toBeGreaterThan(lastWaiting);
    expect(entries.filter((entry) => entry.awaitingTeacher)).toHaveLength(2);
  });
});

describe("a verdict with no score", () => {
  it("never reports a score of zero for a refusal", async () => {
    const entries = await queue.list();
    const blocked = entries.find((entry) => entry.status === "blocked_by_safety");
    expect(blocked).toBeDefined();

    const verdict = await store.getEffective(blocked!.verdictId);
    expect(verdict?.normalizedScore).toBeNull();
    expect(verdict?.aiNormalizedScore).toBeNull();
    expect(verdict?.result).toBeNull();
    // Nothing for the child to read: the model's words are teacher-only.
    expect(verdict?.feedbackToLearner).toBeNull();
    expect(verdict?.criteria).toEqual([]);
    expect(verdict?.statusDetail).toBeTruthy();
  });

  it("says why an unscorable answer could not be judged", async () => {
    const entries = await queue.list();
    const unscorable = entries.find((entry) => entry.status === "unscorable");
    expect(unscorable?.unscorableReason).toBe("too_short");

    const verdict = await store.getEffective(unscorable!.verdictId);
    expect(verdict?.normalizedScore).toBeNull();
  });
});

describe("the child's answer", () => {
  it("is readable from the snapshot the model was given", async () => {
    const entries = await queue.list();
    const graded = entries.find((entry) => entry.status === "graded");
    const subject = await queue.subject(graded!.verdictId);

    expect(subject?.answer).toContain("กล่อง");
    expect(subject?.correlationId).toBeTruthy();
  });

  it("falls back to the raw snapshot rather than showing nothing", () => {
    expect(answerText({ answer: " เขียนไว้ " })).toBe("เขียนไว้");
    expect(answerText({ learnerAnswer: "อีกคีย์หนึ่ง" })).toBe("อีกคีย์หนึ่ง");
    expect(answerText({ unexpected: 1 })).toContain("unexpected");
    expect(answerText(null)).toBeNull();
  });
});

describe("a teacher correcting one skill", () => {
  it("survives a reload, and keeps the AI's level beside it", async () => {
    const entries = await queue.list();
    const graded = entries.find((entry) => entry.status === "graded");
    const verdictId = graded!.verdictId;

    const before = await store.getEffective(verdictId);
    const target = before!.criteria[0]!;
    const newLevel = target.aiLevel === 3 ? 1 : 3;

    await store.recordOverride({
      verdictId,
      teacherUserId,
      skillCode: target.skillCode,
      correctedLevel: newLevel,
      reasonCode: "too_harsh",
      note: "เด็กเขียนเหตุผลไว้ประโยคสุดท้ายแล้ว",
    });

    // A fresh read is what a page refresh does.
    const after = await store.getEffective(verdictId);
    const corrected = after!.criteria.find((c) => c.skillCode === target.skillCode)!;

    expect(corrected.level).toBe(newLevel);
    expect(corrected.aiLevel).toBe(target.aiLevel);
    expect(corrected.teacherCorrected).toBe(true);
    expect(after!.normalizedScore).not.toBeCloseTo(before!.normalizedScore!, 10);
    // The raw model score is untouched — it is half the training label.
    expect(after!.aiNormalizedScore).toBeCloseTo(before!.aiNormalizedScore!, 10);
  });

  it("leaves the skills the teacher did not touch marked as the AI's", async () => {
    const entries = await queue.list();
    const graded = entries.find((entry) => entry.status === "graded");
    const verdict = await store.getEffective(graded!.verdictId);

    const untouched = verdict!.criteria.filter((c) => !c.teacherCorrected);
    expect(untouched.length).toBeGreaterThan(0);
    expect(untouched.every((c) => c.level === c.aiLevel)).toBe(true);
  });

  it("keeps every correction, not just the latest", async () => {
    const entries = await queue.list();
    const graded = entries.find((entry) => entry.status === "graded");
    const verdictId = graded!.verdictId;
    const skillCode = (await store.getEffective(verdictId))!.criteria[0]!.skillCode;

    await store.recordOverride({
      verdictId,
      teacherUserId,
      skillCode,
      correctedLevel: 2,
      reasonCode: "wrong_reasoning",
      note: null,
    });

    const history = (await store.listOverrides(verdictId)).filter(
      (entry) => entry.skillCode === skillCode,
    );
    expect(history.length).toBeGreaterThanOrEqual(2);
    // The latest wins on the screen; the earlier row stays as evidence.
    expect((await store.getEffective(verdictId))!.criteria.find((c) => c.skillCode === skillCode)!
      .level).toBe(2);
  });
});

describe("an unknown verdict", () => {
  it("has no subject rather than an empty one", async () => {
    expect(await queue.subject(uuidv7())).toBeNull();
  });
});
