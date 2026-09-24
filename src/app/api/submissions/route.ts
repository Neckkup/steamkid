import { NextResponse, after } from "next/server";
import { z } from "zod";

import { getItemById, isWrittenItem } from "@/content";
import { gradeForRequest } from "@/lib/learning/grade-request";
import { ensureLearnerRef, getConsentState } from "@/lib/learning/session";
import { getLearningStore } from "@/lib/learning/store";
import { answerCharCount } from "@/lib/learning/text";

export const dynamic = "force-dynamic";

const MAX_SUBMISSION_CHARS = 20_000;

const body = z.object({
  itemId: z.uuid(),
  submissionId: z.uuid().nullish(),
  content: z.string().max(MAX_SUBMISSION_CHARS),
  /** Active editing time since the previous draft, from the client's clock. */
  activeMsDelta: z.number().int().min(0).max(24 * 60 * 60 * 1000),
  /** A draft is autosaved; a submit is the child deciding they are finished. */
  action: z.enum(["draft", "submit"]),
  /** `events.session.id`, when the editor has one. See `/api/attempts`. */
  sessionId: z.uuid().nullish(),
});

/**
 * `POST /api/submissions` — autosave and submit for long-form work.
 *
 * Every draft is appended rather than overwriting the last one. That history is
 * the thing PRO-3 calls out as the company's real asset: the final text says
 * what a child produced, the sequence of drafts says how they got there.
 *
 * Submitting grades (PRO-115). The draft is saved first, always, and only then
 * does `gradeForRequest` call the model: a child's twenty minutes of writing
 * must not depend on a grading call succeeding. The response then says one of
 *
 *   - `graded` — a stored, teacher-correctable verdict with feedback,
 *   - `awaiting_teacher` — the model refused or could not judge it; a verdict
 *     row exists with no score and the work is at the front of the teacher
 *     queue,
 *   - `awaiting_grading` — nothing was graded; `pendingReason` says why. This
 *     is the pre-PRO-115 answer and every failure path still lands on it.
 *
 * A draft (`action: "draft"`) is never graded. Autosave firing a model call
 * every few keystrokes would cost more than the product and would grade work a
 * child has not finished.
 */
export async function POST(request: Request): Promise<Response> {
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const found = await getItemById(parsed.data.itemId);
  if (!found || !isWrittenItem(found.item)) {
    return NextResponse.json({ error: "unknown_item" }, { status: 404 });
  }

  const trimmed = parsed.data.content.trim();
  if (parsed.data.action === "submit" && answerCharCount(trimmed) < found.item.minChars) {
    return NextResponse.json(
      { error: "too_short", minChars: found.item.minChars },
      { status: 422 },
    );
  }
  if (trimmed.length === 0) {
    return NextResponse.json({ error: "empty_draft" }, { status: 422 });
  }

  const consent = await getConsentState();
  if (!consent) {
    return NextResponse.json({ error: "consent_required" }, { status: 403 });
  }

  const learnerRef = await ensureLearnerRef();
  const store = getLearningStore();

  const saved = await store.saveDraft({
    learnerRef,
    lessonId: found.lesson.id,
    itemId: found.item.id,
    submissionId: parsed.data.submissionId ?? null,
    content: parsed.data.content,
    activeMsDelta: parsed.data.activeMsDelta,
  });

  const record =
    parsed.data.action === "submit" ? ((await store.submit(learnerRef, saved.id)) ?? saved) : saved;

  /**
   * Grading runs only on submit, and only after the work is saved above.
   *
   * `attemptNumber: 1` because a project is submitted, not retried: the store
   * keeps one submission per piece of work and every revision is a draft on it.
   * A re-grade of the same submission is a second verdict row, which is what
   * `attempt_number` on the row already allows for.
   */
  const graded =
    record.submittedAt !== null
      ? await gradeForRequest({
          item: found.item,
          submissionText: trimmed,
          learnerRef,
          consent,
          correlationId: record.correlationId,
          subjectType: "submission",
          subjectId: record.id,
          attemptNumber: 1,
          lessonId: found.lesson.id,
          sessionId: parsed.data.sessionId ?? undefined,
          scheduleAfterResponse: after,
        })
      : null;

  return NextResponse.json(
    {
      submissionId: record.id,
      draftNo: record.drafts.length,
      draftCount: record.drafts.length,
      charCount: record.drafts[record.drafts.length - 1]?.charCount ?? 0,
      totalActiveMs: record.totalActiveMs,
      correlationId: record.correlationId,
      submittedAt: record.submittedAt,
      ...verdictFields(graded),
      status: submissionStatus(record.submittedAt, graded),
    },
    { status: parsed.data.action === "submit" ? 201 : 200 },
  );
}

type Graded = Awaited<ReturnType<typeof gradeForRequest>>;

/**
 * `awaiting_grading` is kept for the "we did not grade it" case rather than
 * renamed, because it is still exactly true — the work is in and a human will
 * look — and because the result screen already says that in words a child
 * reads as "fine".
 */
function submissionStatus(submittedAt: string | null, graded: Graded | null): string {
  if (!submittedAt) return "draft_saved";
  if (graded?.kind === "graded") return "graded";
  if (graded?.kind === "awaiting_teacher") return "awaiting_teacher";
  return "awaiting_grading";
}

function verdictFields(graded: Graded | null): Record<string, unknown> {
  if (graded?.kind === "graded") {
    return {
      verdictId: graded.verdictId,
      result: graded.result,
      feedbackToLearner: graded.feedbackToLearner,
      nextStep: graded.nextStep,
    };
  }
  if (graded?.kind === "awaiting_teacher") {
    return { verdictId: graded.verdictId, pendingReason: graded.reason };
  }
  return graded ? { pendingReason: graded.reason } : {};
}
