/**
 * PostgresLearningStore against PGlite + real migrations (PRO-169).
 *
 * Uses the same pattern as verdict-store.test.ts:
 *   - single DB creation in beforeAll (slow; 120s timeout)
 *   - fresh UUIDs per test instead of table cleanup (append-only tables)
 *   - direct SQL inserts for fixtures that the store under test does not own
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/lib/db/test-database";
import { uuidv7 } from "@/lib/ids";

import { PostgresLearningStore } from "./pg-store";
import type { AttemptRecord } from "./store";

let db: TestDatabase;
let store: PostgresLearningStore;

let learnerRef: string;
let lessonId: string;
let itemId: string;

beforeAll(async () => {
  db = await createTestDatabase();
  store = new PostgresLearningStore(db);
}, 120_000);

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  learnerRef = uuidv7();
  lessonId = uuidv7();
  itemId = uuidv7();
});

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

describe("consent", () => {
  it("returns undefined before any consent is stored", async () => {
    const result = await store.getConsent(learnerRef);
    expect(result).toBeUndefined();
  });

  it("stores and retrieves consent", async () => {
    const consent = {
      policyVersion: "v1",
      scopes: ["ai_grading", "behaviour"],
      grantedAt: new Date().toISOString(),
    };

    await store.setConsent(learnerRef, consent);
    const result = await store.getConsent(learnerRef);

    expect(result).toMatchObject({
      policyVersion: "v1",
      scopes: expect.arrayContaining(["ai_grading", "behaviour"]),
    });
  });

  it("updates consent when called a second time", async () => {
    const first = { policyVersion: "v1", scopes: ["behaviour"], grantedAt: new Date().toISOString() };
    const second = { policyVersion: "v2", scopes: ["ai_grading"], grantedAt: new Date().toISOString() };

    await store.setConsent(learnerRef, first);
    await store.setConsent(learnerRef, second);

    const result = await store.getConsent(learnerRef);
    expect(result?.policyVersion).toBe("v2");
    expect(result?.scopes).toContain("ai_grading");
    expect(result?.scopes).not.toContain("behaviour");
  });

  it("deletes consent when setConsent is called with null", async () => {
    const consent = { policyVersion: "v1", scopes: ["behaviour"], grantedAt: new Date().toISOString() };
    await store.setConsent(learnerRef, consent);
    await store.setConsent(learnerRef, null);

    const result = await store.getConsent(learnerRef);
    expect(result).toBeUndefined();
  });

  it("creates the learner row implicitly on first consent grant", async () => {
    await store.setConsent(learnerRef, {
      policyVersion: "v1",
      scopes: [],
      grantedAt: new Date().toISOString(),
    });

    const { rows } = await db.query(
      `SELECT id FROM app.learner WHERE public_ref = $1::uuid`,
      [learnerRef],
    );
    expect(rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Attempts
// ---------------------------------------------------------------------------

describe("attempts", () => {
  it("returns 1 as next attempt no when no prior attempts exist", async () => {
    const no = await store.nextAttemptNo(learnerRef, itemId);
    expect(no).toBe(1);
  });

  it("increments attempt no with each recorded attempt", async () => {
    const base: Omit<AttemptRecord, "attemptNo" | "id"> = {
      learnerRef,
      itemId,
      lessonId,
      answer: "ทดสอบ",
      result: null,
      normalizedScore: null,
      source: "deterministic",
      pendingAi: false,
      timeOnItemMs: 3000,
      activeTimeOnItemMs: 2500,
      answerChanges: 2,
      hintsUsed: 0,
      correlationId: uuidv7(),
      submittedAt: new Date().toISOString(),
    };

    await store.recordAttempt({ ...base, id: uuidv7(), attemptNo: 1 });
    expect(await store.nextAttemptNo(learnerRef, itemId)).toBe(2);

    await store.recordAttempt({ ...base, id: uuidv7(), attemptNo: 2 });
    expect(await store.nextAttemptNo(learnerRef, itemId)).toBe(3);
  });

  it("records and retrieves attempts for a lesson", async () => {
    const attemptId = uuidv7();
    await store.recordAttempt({
      id: attemptId,
      learnerRef,
      itemId,
      lessonId,
      attemptNo: 1,
      answer: { text: "ตอบ" },
      result: "correct",
      normalizedScore: 1,
      source: "deterministic",
      pendingAi: false,
      timeOnItemMs: 5000,
      activeTimeOnItemMs: 4000,
      answerChanges: 1,
      hintsUsed: 0,
      correlationId: uuidv7(),
      submittedAt: new Date().toISOString(),
    });

    const attempts = await store.listAttempts(learnerRef, lessonId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      id: attemptId,
      learnerRef,
      itemId,
      lessonId,
      attemptNo: 1,
      result: "correct",
      normalizedScore: 1,
      source: "deterministic",
    });
  });

  it("does not list attempts for a different lesson", async () => {
    await store.recordAttempt({
      id: uuidv7(),
      learnerRef,
      itemId,
      lessonId,
      attemptNo: 1,
      answer: "ตอบ",
      result: null,
      normalizedScore: null,
      source: "deterministic",
      pendingAi: false,
      timeOnItemMs: 1000,
      activeTimeOnItemMs: 900,
      answerChanges: 0,
      hintsUsed: 0,
      correlationId: uuidv7(),
      submittedAt: new Date().toISOString(),
    });

    const otherLesson = uuidv7();
    const attempts = await store.listAttempts(learnerRef, otherLesson);
    expect(attempts).toHaveLength(0);
  });

  it("is idempotent: duplicate id is silently ignored", async () => {
    const id = uuidv7();
    const attempt: AttemptRecord = {
      id,
      learnerRef,
      itemId,
      lessonId,
      attemptNo: 1,
      answer: "ตอบ",
      result: null,
      normalizedScore: null,
      source: "deterministic",
      pendingAi: false,
      timeOnItemMs: 1000,
      activeTimeOnItemMs: 900,
      answerChanges: 0,
      hintsUsed: 0,
      correlationId: uuidv7(),
      submittedAt: new Date().toISOString(),
    };

    await store.recordAttempt(attempt);
    await expect(store.recordAttempt(attempt)).resolves.toBeUndefined();
    expect(await store.listAttempts(learnerRef, lessonId)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Submissions and drafts
// ---------------------------------------------------------------------------

describe("submissions", () => {
  it("creates a new submission on the first saveDraft call", async () => {
    const record = await store.saveDraft({
      learnerRef,
      lessonId,
      itemId,
      submissionId: null,
      content: "เนื้อหา",
      activeMsDelta: 1000,
    });

    expect(record.id).toBeTruthy();
    expect(record.learnerRef).toBe(learnerRef);
    expect(record.lessonId).toBe(lessonId);
    expect(record.itemId).toBe(itemId);
    expect(record.drafts).toHaveLength(1);
    expect(record.drafts[0]!.draftNo).toBe(1);
    expect(record.drafts[0]!.content).toBe("เนื้อหา");
    expect(record.submittedAt).toBeNull();
    expect(record.totalActiveMs).toBe(1000);
  });

  it("appends a second draft to an existing submission", async () => {
    const first = await store.saveDraft({
      learnerRef,
      lessonId,
      itemId,
      submissionId: null,
      content: "ร่างแรก",
      activeMsDelta: 500,
    });

    const second = await store.saveDraft({
      learnerRef,
      lessonId,
      itemId,
      submissionId: first.id,
      content: "ร่างที่สอง",
      activeMsDelta: 700,
    });

    expect(second.id).toBe(first.id);
    expect(second.drafts).toHaveLength(2);
    expect(second.drafts[1]!.draftNo).toBe(2);
    expect(second.drafts[1]!.content).toBe("ร่างที่สอง");
    expect(second.totalActiveMs).toBe(1200);
  });

  it("creates a fresh submission when submissionId belongs to another learner", async () => {
    const otherRef = uuidv7();
    const otherRecord = await store.saveDraft({
      learnerRef: otherRef,
      lessonId,
      itemId,
      submissionId: null,
      content: "คนอื่น",
      activeMsDelta: 0,
    });

    const mine = await store.saveDraft({
      learnerRef,
      lessonId,
      itemId,
      submissionId: otherRecord.id,
      content: "ของฉัน",
      activeMsDelta: 200,
    });

    expect(mine.id).not.toBe(otherRecord.id);
    expect(mine.drafts).toHaveLength(1);
    expect(mine.drafts[0]!.content).toBe("ของฉัน");
  });

  it("marks a submission as submitted", async () => {
    const draft = await store.saveDraft({
      learnerRef,
      lessonId,
      itemId,
      submissionId: null,
      content: "เสร็จแล้ว",
      activeMsDelta: 2000,
    });

    const submitted = await store.submit(learnerRef, draft.id);
    expect(submitted).toBeDefined();
    expect(submitted!.submittedAt).toBeTruthy();
    expect(submitted!.id).toBe(draft.id);
  });

  it("returns undefined when submitting a nonexistent submission", async () => {
    const result = await store.submit(learnerRef, uuidv7());
    expect(result).toBeUndefined();
  });

  it("getSubmission returns the record by id", async () => {
    const saved = await store.saveDraft({
      learnerRef,
      lessonId,
      itemId,
      submissionId: null,
      content: "ทดสอบ",
      activeMsDelta: 0,
    });

    const found = await store.getSubmission(learnerRef, saved.id);
    expect(found).toBeDefined();
    expect(found!.id).toBe(saved.id);
    expect(found!.drafts).toHaveLength(1);
  });

  it("getSubmission returns undefined for a nonexistent id", async () => {
    const result = await store.getSubmission(learnerRef, uuidv7());
    expect(result).toBeUndefined();
  });

  it("listSubmissions returns all submissions for a lesson", async () => {
    await store.saveDraft({ learnerRef, lessonId, itemId, submissionId: null, content: "หนึ่ง", activeMsDelta: 0 });
    await store.saveDraft({ learnerRef, lessonId, itemId, submissionId: null, content: "สอง", activeMsDelta: 0 });

    const subs = await store.listSubmissions(learnerRef, lessonId);
    expect(subs).toHaveLength(2);
  });

  it("listSubmissions returns empty for unknown learner", async () => {
    const subs = await store.listSubmissions(uuidv7(), lessonId);
    expect(subs).toHaveLength(0);
  });
});
