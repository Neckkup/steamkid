import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getItemById, isWrittenItem } from "@/content";
import { gradeItem, isClosedItem, type ItemAnswer } from "@/lib/learning/grade";
import { ensureLearnerRef, getConsentState, hasScope } from "@/lib/learning/session";
import { getLearningStore } from "@/lib/learning/store";
import { answerCharCount } from "@/lib/learning/text";

export const dynamic = "force-dynamic";

/**
 * Longest answer a child may submit for one item.
 *
 * Generous — a project answer is meant to be long — but bounded, because this
 * is the endpoint a child's own text arrives on and an unbounded body is the
 * cheapest way to take it down.
 */
const MAX_ANSWER_CHARS = 8_000;

const answerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("mcq"), choiceId: z.string().max(64) }),
  z.object({ type: z.literal("numeric"), value: z.number().finite() }),
  z.object({ type: z.literal("ordering"), order: z.array(z.string().max(64)).max(20) }),
  z.object({ type: z.literal("text"), text: z.string().max(MAX_ANSWER_CHARS) }),
]);

const body = z.object({
  itemId: z.uuid(),
  answer: answerSchema,
  /** Measured by the client; the growth formulas read the active figure. */
  timeOnItemMs: z.number().int().min(0).max(24 * 60 * 60 * 1000),
  activeTimeOnItemMs: z.number().int().min(0).max(24 * 60 * 60 * 1000),
  answerChanges: z.number().int().min(0).max(10_000),
  hintsUsed: z.number().int().min(0).max(20),
});

/**
 * `POST /api/attempts` — one answer to one exercise item.
 *
 * Grading happens here rather than in the browser for the obvious reason: the
 * correct answer must not be in a bundle a child can read. The response carries
 * the result and the explanation, and for written items it carries
 * `pending_ai` — the honest state until PRO-8 exists — never a made-up score.
 *
 * The `attempt_id` and `correlation_id` in the response are the ones the client
 * puts in `item.answer_submitted` and `item.result_shown`, so a behaviour event
 * and the stored attempt can be joined later, and so `correlation_id` is
 * already the Langfuse trace id when a grader picks the work up.
 */
export async function POST(request: Request): Promise<Response> {
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const found = await getItemById(parsed.data.itemId);
  if (!found) {
    return NextResponse.json({ error: "unknown_item" }, { status: 404 });
  }
  const { lesson, item } = found;

  const answer = parsed.data.answer as ItemAnswer;
  const answerMatchesItem = isClosedItem(item) ? answer.type === item.type : answer.type === "text";
  if (!answerMatchesItem) {
    return NextResponse.json({ error: "answer_type_mismatch" }, { status: 422 });
  }
  if (answer.type === "text" && answer.text.trim().length === 0) {
    return NextResponse.json({ error: "empty_answer" }, { status: 422 });
  }
  /**
   * The same `minChars` floor `POST /api/submissions` enforces (PRO-44).
   *
   * The practice screen already disables the submit button below it, but a
   * client-side gate is a courtesy, not a rule: a stale tab, a broken build or
   * a direct POST used to walk a four-character answer straight into the
   * `pending_ai` queue, where PRO-8's grader would later read it as real
   * schoolwork. Rejecting here keeps the queue clean and keeps the two written
   * paths — exercise item and lesson project — telling a child the same thing.
   */
  if (
    answer.type === "text" &&
    isWrittenItem(item) &&
    answerCharCount(answer.text) < item.minChars
  ) {
    return NextResponse.json({ error: "too_short", minChars: item.minChars }, { status: 422 });
  }

  const consent = await getConsentState();
  if (!consent) {
    return NextResponse.json({ error: "consent_required" }, { status: 403 });
  }

  const learnerRef = await ensureLearnerRef();
  const store = getLearningStore();
  const attemptNo = await store.nextAttemptNo(learnerRef, item.id);
  if (attemptNo > item.maxAttempts) {
    return NextResponse.json({ error: "max_attempts_reached" }, { status: 409 });
  }

  const outcome = gradeItem(item, answer);
  const attemptId = randomUUID();
  const correlationId = randomUUID();

  await store.recordAttempt({
    id: attemptId,
    learnerRef,
    itemId: item.id,
    lessonId: lesson.id,
    attemptNo,
    answer,
    result: outcome.status === "graded" ? outcome.result : null,
    normalizedScore: outcome.status === "graded" ? outcome.normalizedScore : null,
    source: outcome.source,
    pendingAi: outcome.status === "pending_ai",
    timeOnItemMs: parsed.data.timeOnItemMs,
    activeTimeOnItemMs: parsed.data.activeTimeOnItemMs,
    answerChanges: parsed.data.answerChanges,
    hintsUsed: parsed.data.hintsUsed,
    correlationId,
    submittedAt: new Date().toISOString(),
  });

  if (outcome.status === "pending_ai") {
    return NextResponse.json({
      attemptId,
      attemptNo,
      correlationId,
      status: "pending_ai",
      /**
       * Why the child is not getting feedback: told to the screen so it can say
       * so in words, instead of the screen guessing from a missing field.
       */
      pendingReason: hasScope(consent, "ai_grading") ? "grader_not_available" : "consent_missing",
      attemptsLeft: item.maxAttempts - attemptNo,
    });
  }

  return NextResponse.json({
    attemptId,
    attemptNo,
    correlationId,
    status: "graded",
    result: outcome.result,
    explanation: outcome.explanation,
    attemptsLeft: item.maxAttempts - attemptNo,
  });
}
