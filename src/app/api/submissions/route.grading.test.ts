/**
 * The proof PRO-115 asked for: a child presses send and a real verdict exists.
 *
 * Everything here is real except the model — the route, the learning store, the
 * consent gate, the verdict store, and the migrations a deploy actually
 * applies. Gemini is the one thing stubbed, because the question this file
 * answers is "does the wiring reach the database", not "does the model grade
 * well"; that number comes from `scripts/grading-eval.ts` against the Langfuse
 * dataset, and a mocked model cannot tell us anything about it.
 *
 * The three cases are the three the product must keep apart: a score, a refusal
 * and an answer the model could not judge. Two of them must reach a teacher
 * without ever reaching the child as a zero.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { listLessons, isWrittenItem, type WrittenItem } from "@/content";
import { createTestDatabase, type TestDatabase } from "@/lib/db/test-database";
import { uuidv7 } from "@/lib/ids";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = jar.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string) => {
      jar.set(name, value);
    },
  }),
}));

/** `after()` needs a request context this test does not have. */
vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, after: (task: () => unknown) => void task() };
});

/**
 * The model, stubbed at the `callModel` boundary rather than at `gradeWritten`.
 *
 * That leaves the whole of `ai-grade.ts` under test — the schema parse, the
 * criteria-mismatch guard, the weighting, the safety-block mapping — which is
 * exactly the part that decides whether a verdict is a score or a referral.
 */
const modelResponse = vi.fn<() => unknown>();

vi.mock("@/lib/ai/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai/client")>("@/lib/ai/client");
  return {
    ...actual,
    callModel: async () => {
      const outcome = modelResponse();
      if (outcome instanceof Error) throw outcome;
      return {
        text: JSON.stringify(outcome),
        json: outcome,
        traceId: null,
        traceUrl: null,
        model: "gemini-3.8-flash",
        promptName: "grading/sci-cer-short",
        promptVersion: 7,
        promptSource: "langfuse",
        usage: { inputTokens: 900, outputTokens: 180 },
        cost: { total: 0.000_214 },
        latencyMs: 2_140,
        stopReason: "STOP",
      };
    },
  };
});

const { POST } = await import("./route");
const { ModelSafetyBlockError } = await import("@/lib/ai/client");
const { setVerdictDb } = await import("@/lib/learning/verdict-runtime");
const { SqlReviewQueue } = await import("@/lib/learning/review-queue");
const { getLearningStore } = await import("@/lib/learning/store");

/**
 * The browser's half of consent.
 *
 * Two stores hold this today and both have to agree: the learning store the
 * route reads (`getConsentState`) and `app.consent_record`, which
 * `SqlVerdictStore.save()` gates on inside the INSERT. Seeding only one is how
 * you get a grading call whose verdict is then silently refused.
 */
function grantInSession(ref: string, scopes: string[]): Promise<void> {
  return getLearningStore().setConsent(ref, {
    policyVersion: "v1",
    scopes,
    grantedAt: new Date().toISOString(),
  });
}

let db: TestDatabase;
let item: WrittenItem;
let learnerId: string;
let learnerRef: string;

beforeAll(async () => {
  db = await createTestDatabase();
  setVerdictDb(db);
  item = await firstProjectItem();
}, 120_000);

afterAll(async () => {
  setVerdictDb(null);
  await db.close();
});

beforeEach(async () => {
  jar.clear();
  modelResponse.mockReset();

  // A new child each time: every table under test is append-only.
  learnerId = uuidv7();
  learnerRef = uuidv7();
  const guardianId = uuidv7();

  await db.query(`INSERT INTO app.learner (id, public_ref, grade_band) VALUES ($1, $2, 'p5')`, [
    learnerId,
    learnerRef,
  ]);
  await db.query(
    `INSERT INTO identity.user_account (id, role, email, auth_provider, auth_subject_id)
     VALUES ($1::uuid, 'guardian', $2, 'test', $1::text)`,
    [guardianId, `guardian-${guardianId}@example.test`],
  );
  await db.query(
    `INSERT INTO app.consent_record
       (id, learner_id, guardian_user_id, policy_version, scope, granted, method, evidence)
     VALUES ($1, $2, $3, 'v1', 'ai_grading', true, 'guardian_web_verified_email', '{}')`,
    [uuidv7(), learnerId, guardianId],
  );

  // The browser's side of the same two facts: who this is, and what the
  // guardian agreed to.
  jar.set("sk_learner", learnerRef);
  await grantInSession(learnerRef, ["ai_grading"]);
});

async function firstProjectItem(): Promise<WrittenItem> {
  for (const lesson of await listLessons()) {
    for (const candidate of lesson.items) {
      if (isWrittenItem(candidate) && candidate.type === "short_text") return candidate;
    }
  }
  throw new Error("the course has no written item to submit against");
}

/** A long enough answer that the route's own `minChars` floor is not what fires. */
function answerText(): string {
  return "เมื่อก่อนกล่องอยู่เฉย ๆ แล้วตอนนี้มันเลื่อนไปข้างหน้า แปลว่ามีแรงมาผลักมัน".repeat(2);
}

function submit(): Promise<Response> {
  return POST(
    new Request("http://localhost/api/submissions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        itemId: item.id,
        content: answerText(),
        activeMsDelta: 240_000,
        action: "submit",
      }),
    }),
  );
}

function gradedResponse(levels: Record<string, number>) {
  return {
    criteria: Object.entries(levels).map(([skillCode, level]) => ({
      skillCode,
      level,
      reason: "เหตุผลของผู้ตรวจ",
      evidence: "กล่องเลื่อนไปข้างหน้า",
    })),
    feedbackToLearner: "หนูสังเกตเก่งมาก ที่บอกว่ากล่องเคยอยู่เฉย ๆ แล้วตอนนี้เลื่อนไปแล้ว",
    nextStep: "ลองเติมอีกประโยคว่าแรงมาจากไหน",
    offTopic: false,
    tooShortToJudge: false,
    instructionAttempt: false,
  };
}

/** The levels this item's rubric actually asks for, all at 2. */
function everySkillAtLevel(level: number): Record<string, number> {
  return Object.fromEntries(Object.keys(item.skillWeights).map((skill) => [skill, level]));
}

async function verdictRows(): Promise<
  {
    id: string;
    verdict_status: string;
    normalized_score: string | null;
    correlation_id: string;
    subject_id: string;
    langfuse_trace_id: string;
  }[]
> {
  const { rows } = await db.query<{
    id: string;
    verdict_status: string;
    normalized_score: string | null;
    correlation_id: string;
    subject_id: string;
    langfuse_trace_id: string;
  }>(
    `SELECT id, verdict_status, normalized_score, correlation_id, subject_id, langfuse_trace_id
     FROM app.ai_verdict WHERE learner_id = $1::uuid`,
    [learnerId],
  );
  return rows;
}

describe("POST /api/submissions — a child's work reaches the grader", () => {
  it("stores a verdict for the submission the child just sent", async () => {
    modelResponse.mockReturnValue(gradedResponse(everySkillAtLevel(2)));

    const response = await submit();
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;

    expect(body.status).toBe("graded");
    expect(body.feedbackToLearner).toContain("หนูสังเกตเก่งมาก");
    expect(body.result).toBe("partial");

    const rows = await verdictRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(body.verdictId);
    expect(rows[0].verdict_status).toBe("graded");
    expect(rows[0].subject_id).toBe(body.submissionId);
    // The join the whole data model rests on: one id ties the child's clicks,
    // the API call, the stored verdict and the Langfuse trace together.
    expect(rows[0].correlation_id).toBe(body.correlationId);
    expect(rows[0].langfuse_trace_id).toBe(body.correlationId);
  });

  it("sends a safety-blocked answer to a teacher, not to a score of zero", async () => {
    modelResponse.mockReturnValue(new ModelSafetyBlockError("SAFETY", "response"));

    const body = (await (await submit()).json()) as Record<string, unknown>;

    expect(body.status).toBe("awaiting_teacher");
    expect(body.pendingReason).toBe("blocked_by_safety");
    expect(body.result).toBeUndefined();

    const rows = await verdictRows();
    expect(rows[0].verdict_status).toBe("blocked_by_safety");
    expect(rows[0].normalized_score).toBeNull();

    const queue = await new SqlReviewQueue(db).list();
    const entry = queue.find((row) => row.verdictId === rows[0].id);
    expect(entry?.awaitingTeacher).toBe(true);
    expect(entry?.learnerRef).toBe(learnerRef);
  });

  it("sends an answer the model could not judge to a teacher too", async () => {
    modelResponse.mockReturnValue({
      ...gradedResponse(everySkillAtLevel(0)),
      offTopic: true,
    });

    const body = (await (await submit()).json()) as Record<string, unknown>;

    expect(body.status).toBe("awaiting_teacher");
    expect(body.pendingReason).toBe("off_topic");

    const rows = await verdictRows();
    expect(rows[0].verdict_status).toBe("unscorable");
    expect(rows[0].normalized_score).toBeNull();
  });

  it("keeps the child's work and says nothing was graded when the model fails", async () => {
    modelResponse.mockReturnValue(new Error("gemini unavailable"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const body = (await (await submit()).json()) as Record<string, unknown>;

    expect(body.status).toBe("awaiting_grading");
    expect(body.pendingReason).toBe("grader_failed");
    expect(body.submissionId).toEqual(expect.any(String));
    expect(await verdictRows()).toHaveLength(0);

    errors.mockRestore();
  });

  it("never grades an autosaved draft", async () => {
    modelResponse.mockReturnValue(gradedResponse(everySkillAtLevel(3)));

    const response = await POST(
      new Request("http://localhost/api/submissions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          itemId: item.id,
          content: answerText(),
          activeMsDelta: 5_000,
          action: "draft",
        }),
      }),
    );

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe("draft_saved");
    expect(modelResponse).not.toHaveBeenCalled();
    expect(await verdictRows()).toHaveLength(0);
  });

  it("does not call the model without an ai_grading grant", async () => {
    await grantInSession(learnerRef, ["behaviour_analytics"]);
    modelResponse.mockReturnValue(gradedResponse(everySkillAtLevel(3)));

    const body = (await (await submit()).json()) as Record<string, unknown>;

    expect(body.status).toBe("awaiting_grading");
    expect(body.pendingReason).toBe("consent_missing");
    expect(modelResponse).not.toHaveBeenCalled();
    expect(await verdictRows()).toHaveLength(0);
  });

  it("does not grade for a cookie that matches no learner row", async () => {
    jar.set("sk_learner", uuidv7());
    await grantInSession(jar.get("sk_learner")!, ["ai_grading"]);
    modelResponse.mockReturnValue(gradedResponse(everySkillAtLevel(3)));

    const body = (await (await submit()).json()) as Record<string, unknown>;

    expect(body.status).toBe("awaiting_grading");
    expect(body.pendingReason).toBe("unknown_learner");
    expect(modelResponse).not.toHaveBeenCalled();
  });
});
