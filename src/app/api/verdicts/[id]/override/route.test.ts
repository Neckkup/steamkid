/**
 * `POST /api/verdicts/:id/override` driven end to end, against a real Postgres.
 *
 * `verdict-store.test.ts` proves the store's rules. This proves the seam a
 * teacher's browser actually talks to: that the endpoint refuses a caller who
 * is not a teacher, that it appends rather than overwrites, and that the
 * response carries the corrected score a child would now be shown. That seam is
 * where an authorisation mistake would live, so it is tested rather than
 * inferred from its halves.
 *
 * Everything below is synthetic. No real learner row exists in this repository.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/lib/db/test-database";
import { uuidv7 } from "@/lib/ids";
import { GRADE_VERSION, type AiVerdict } from "@/lib/learning/ai-grade";
import { TEACHER_COOKIE } from "@/lib/learning/teacher-session";
import { setVerdictDb } from "@/lib/learning/verdict-runtime";
import { SqlVerdictStore } from "@/lib/learning/verdict-store";

/**
 * `next/headers` needs a request scope that a direct handler call does not
 * have, so the cookie jar is stubbed. The endpoint still reads it through the
 * same `getTeacherIdentity()` the real request path uses.
 */
const cookieJar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieJar.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
}));

const { POST, GET } = await import("./route");

let db: TestDatabase;
let store: SqlVerdictStore;
let learnerId: string;
let teacherId: string;
let guardianId: string;
let verdictId: string;

function post(id: string, body: unknown): Promise<Response> {
  return POST(
    new Request(`https://steamkid.test/api/verdicts/${id}/override`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

function get(id: string): Promise<Response> {
  return GET(new Request(`https://steamkid.test/api/verdicts/${id}/override`), {
    params: Promise.resolve({ id }),
  });
}

async function seedTeacher(role: "teacher" | "guardian"): Promise<string> {
  const id = uuidv7();
  await db.query(
    `INSERT INTO identity.user_account (id, role, email, auth_provider, auth_subject_id)
     VALUES ($1::uuid, $2::text, $3, 'test', $1::text)`,
    [id, role, `${role}-${id}@example.test`],
  );
  return id;
}

const verdict = (itemId: string): AiVerdict => ({
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
      reason: "ตั้งคำทำนายชัด แต่ไม่ได้บอกเงื่อนไขที่จะแปลว่าผิด",
      evidence: null,
    },
    {
      skillCode: "COMM.SCI_WRITING",
      level: 3,
      weight: 0.4,
      reason: "อ่านเข้าใจ เรียงลำดับดี",
      evidence: null,
    },
  ],
  normalizedScore: 0.8,
  result: "correct",
  feedbackToLearner: "เขียนได้ดีมาก",
  nextStep: "ลองบอกด้วยว่าผลแบบไหนจะแปลว่าคิดผิด",
  instructionAttempt: false,
});

beforeAll(async () => {
  db = await createTestDatabase();
  store = new SqlVerdictStore(db);
  setVerdictDb(db);
  // The endpoint refuses outright in the production tier (no teacher sign-in
  // exists yet); these tests are about the local and preview behaviour.
  vi.stubEnv("APP_ENV", "local");
}, 120_000);

afterAll(async () => {
  setVerdictDb(null);
  vi.unstubAllEnvs();
  await db.close();
});

beforeEach(async () => {
  cookieJar.clear();
  learnerId = uuidv7();
  const subjectId = uuidv7();
  const itemId = uuidv7();

  await db.query(`INSERT INTO app.learner (id, public_ref, grade_band) VALUES ($1, $2, 'p5')`, [
    learnerId,
    uuidv7(),
  ]);
  teacherId = await seedTeacher("teacher");
  guardianId = await seedTeacher("guardian");

  // A verdict is only storable for a learner whose guardian said yes to AI
  // grading — the store enforces it, so the fixture has to say it out loud.
  await db.query(
    `INSERT INTO app.consent_record
       (id, learner_id, guardian_user_id, policy_version, scope, granted, method, evidence)
     VALUES ($1, $2, $3, 'v1', 'ai_grading', true, 'guardian_web_verified_email', '{}')`,
    [uuidv7(), learnerId, guardianId],
  );

  const stored = await store.save({
    verdict: verdict(itemId),
    learnerId,
    subjectType: "attempt",
    subjectId,
    attemptNumber: 1,
    correlationId: uuidv7(),
    inputSnapshot: { learnerAnswer: "[REDACTED]" },
    redactionVersion: "redact@1",
  });
  verdictId = stored.id;
});

describe("a teacher correcting one skill", () => {
  it("appends a correction and answers with the score a child would now see", async () => {
    cookieJar.set(TEACHER_COOKIE, teacherId);

    const response = await post(verdictId, {
      skillCode: "SCI.HYPOTHESIS",
      correctedLevel: 3,
      reasonCode: "too_harsh",
      note: "เด็กบอกเงื่อนไขไว้ในประโยคถัดไป",
    });
    expect(response.status).toBe(201);

    const body = (await response.json()) as {
      override: { originalLevel: number; correctedLevel: number };
      verdict: { normalizedScore: number; teacherCorrected: boolean; result: string };
    };

    expect(body.override.originalLevel).toBe(2);
    expect(body.override.correctedLevel).toBe(3);
    expect(body.verdict.teacherCorrected).toBe(true);
    expect(body.verdict.normalizedScore).toBeCloseTo(1, 10);
    expect(body.verdict.result).toBe("correct");

    // A row, not an edit.
    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM app.teacher_correction WHERE ai_verdict_id = $1`,
      [verdictId],
    );
    expect(rows[0]?.count).toBe("1");

    // And the AI's own level is still there to compare against.
    const ai = await db.query<{ level: number }>(
      `SELECT level FROM app.ai_verdict_criterion
       WHERE verdict_id = $1 AND skill_code = 'SCI.HYPOTHESIS'`,
      [verdictId],
    );
    expect(ai.rows[0]?.level).toBe(2);
  });

  it("keeps every correction when a teacher corrects twice", async () => {
    cookieJar.set(TEACHER_COOKIE, teacherId);

    await post(verdictId, { skillCode: "SCI.HYPOTHESIS", correctedLevel: 3, reasonCode: "too_harsh" });
    await post(verdictId, {
      skillCode: "SCI.HYPOTHESIS",
      correctedLevel: 1,
      reasonCode: "too_lenient",
    });

    const body = (await (await get(verdictId)).json()) as {
      overrides: { correctedLevel: number; originalLevel: number }[];
      verdict: { normalizedScore: number };
    };

    expect(body.overrides.map((o) => o.correctedLevel)).toEqual([3, 1]);
    expect(body.overrides.map((o) => o.originalLevel)).toEqual([2, 2]);
    // The latest correction is the one that counts: 0.6*1/3 + 0.4*1 = 0.6.
    expect(body.verdict.normalizedScore).toBeCloseTo(0.6, 10);
  });
});

describe("who is allowed to correct", () => {
  it("refuses a request with no teacher behind it", async () => {
    const response = await post(verdictId, {
      skillCode: "SCI.HYPOTHESIS",
      correctedLevel: 3,
      reasonCode: "too_harsh",
    });
    expect(response.status).toBe(401);
  });

  it("refuses a guardian account holding a teacher cookie", async () => {
    cookieJar.set(TEACHER_COOKIE, guardianId);

    const response = await post(verdictId, {
      skillCode: "SCI.HYPOTHESIS",
      correctedLevel: 3,
      reasonCode: "too_harsh",
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "not_a_teacher" });

    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM app.teacher_correction WHERE ai_verdict_id = $1`,
      [verdictId],
    );
    expect(rows[0]?.count).toBe("0");
  });

  /**
   * `env` is parsed once at module load, so this re-imports the route with
   * `APP_ENV=production` rather than stubbing around a value that is already
   * frozen — otherwise the test would pass against a module that never read the
   * stub and would keep passing if the guard were deleted.
   */
  it("does not exist at all in the production tier", async () => {
    cookieJar.set(TEACHER_COOKIE, teacherId);
    vi.resetModules();
    vi.stubEnv("APP_ENV", "production");
    try {
      const production = await import("./route");
      const response = await production.POST(
        new Request(`https://steamkid.test/api/verdicts/${verdictId}/override`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            skillCode: "SCI.HYPOTHESIS",
            correctedLevel: 3,
            reasonCode: "too_harsh",
          }),
        }),
        { params: Promise.resolve({ id: verdictId }) },
      );
      expect(response.status).toBe(404);
    } finally {
      vi.stubEnv("APP_ENV", "local");
      vi.resetModules();
    }

    // Nothing was written by the refused request.
    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM app.teacher_correction WHERE ai_verdict_id = $1`,
      [verdictId],
    );
    expect(rows[0]?.count).toBe("0");
  });
});

describe("requests that cannot be honoured", () => {
  it("rejects a level outside the rubric's 0-3", async () => {
    cookieJar.set(TEACHER_COOKIE, teacherId);
    const response = await post(verdictId, {
      skillCode: "SCI.HYPOTHESIS",
      correctedLevel: 7,
      reasonCode: "too_harsh",
    });
    expect(response.status).toBe(400);
  });

  it("rejects a reason code nobody agreed to", async () => {
    cookieJar.set(TEACHER_COOKIE, teacherId);
    const response = await post(verdictId, {
      skillCode: "SCI.HYPOTHESIS",
      correctedLevel: 3,
      reasonCode: "felt_like_it",
    });
    expect(response.status).toBe(400);
  });

  it("answers 404 for a skill this verdict was never scored on", async () => {
    cookieJar.set(TEACHER_COOKIE, teacherId);
    const response = await post(verdictId, {
      skillCode: "SCI.NOT_ON_THIS_ITEM",
      correctedLevel: 3,
      reasonCode: "other",
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "unknown_skill" });
  });

  it("answers 404 for a verdict that does not exist", async () => {
    cookieJar.set(TEACHER_COOKIE, teacherId);
    const response = await post(uuidv7(), {
      skillCode: "SCI.HYPOTHESIS",
      correctedLevel: 3,
      reasonCode: "other",
    });
    expect(response.status).toBe(404);
  });
});
