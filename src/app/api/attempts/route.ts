import { randomUUID } from "node:crypto";
import { NextResponse, after } from "next/server";
import { z } from "zod";

import { getItemById, isWrittenItem } from "@/content";
import { gradeForRequest } from "@/lib/learning/grade-request";
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
  /**
   * `events.session.id` — the id the client already puts on every behaviour
   * event. Optional because the practice screen does not send it yet; when it
   * does, one sitting groups as one Langfuse session instead of a row of
   * unrelated grading traces.
   */
  sessionId: z.uuid().nullish(),
});

/**
 * `POST /api/attempts` — one answer to one exercise item.
 *
 * Grading happens here rather than in the browser for the obvious reason: the
 * correct answer must not be in a bundle a child can read. A closed item is
 * graded by `gradeItem`; a written one goes to the AI grader through
 * `gradeForRequest` (PRO-115), which stores a verdict before it returns one.
 *
 * Four statuses, and the difference between them matters:
 *
 * - `graded` — a score exists, from the deterministic grader or from the AI.
 * - `awaiting_teacher` — the model refused or could not judge it. A verdict row
 *   exists with no score and the work is in the teacher queue. Never a zero.
 * - `pending_ai` — nothing was graded, and `pendingReason` says why (no
 *   consent, the kill switch, no learner row, a timeout, a failure). The
 *   child's answer is stored either way.
 * - `403 consent_required` — there is no consent record at all.
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
    /**
     * The written path (PRO-115). The attempt is already stored above, so the
     * child's work survives whatever the grader does next, and every failure
     * inside `gradeForRequest` comes back as `pending_ai` with a reason — the
     * same response this endpoint gave before the grader was connected.
     */
    const graded =
      isWrittenItem(item) && answer.type === "text"
        ? await gradeForRequest({
            item,
            submissionText: answer.text,
            learnerRef,
            consent,
            correlationId,
            subjectType: "attempt",
            subjectId: attemptId,
            attemptNumber: attemptNo,
            lessonId: lesson.id,
            sessionId: parsed.data.sessionId ?? undefined,
            scheduleAfterResponse: after,
          })
        : { kind: "pending_ai" as const, reason: "grader_unavailable" as const };

    const base = { attemptId, attemptNo, correlationId, attemptsLeft: item.maxAttempts - attemptNo };

    if (graded.kind === "graded") {
      return NextResponse.json({
        ...base,
        status: "graded",
        source: "ai",
        result: graded.result,
        // The child-facing field is named `explanation` on the deterministic
        // path, and the practice screen reads that one key for both. A second
        // name would mean a screen that renders one grader and not the other.
        explanation: graded.feedbackToLearner,
        nextStep: graded.nextStep,
        verdictId: graded.verdictId,
      });
    }

    if (graded.kind === "awaiting_teacher") {
      /**
       * The model refused, or could not judge the answer. Not a score of zero
       * and not a silent failure: the verdict row exists with no score, and it
       * is already at the front of the teacher queue.
       */
      return NextResponse.json({
        ...base,
        status: "awaiting_teacher",
        pendingReason: graded.reason,
        verdictId: graded.verdictId,
      });
    }

    return NextResponse.json({
      ...base,
      status: "pending_ai",
      /**
       * Why the child is not getting feedback: told to the screen so it can say
       * so in words, instead of the screen guessing from a missing field.
       */
      pendingReason: hasScope(consent, "ai_grading") ? graded.reason : "consent_missing",
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
