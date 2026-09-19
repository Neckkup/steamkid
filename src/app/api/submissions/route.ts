import { NextResponse } from "next/server";
import { z } from "zod";

import { getItemById, isWrittenItem } from "@/content";
import { ensureLearnerRef, getConsentState } from "@/lib/learning/session";
import { getLearningStore } from "@/lib/learning/store";

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
});

/**
 * `POST /api/submissions` — autosave and submit for long-form work.
 *
 * Every draft is appended rather than overwriting the last one. That history is
 * the thing PRO-3 calls out as the company's real asset: the final text says
 * what a child produced, the sequence of drafts says how they got there.
 *
 * Submitting does not grade. There is no grading engine yet (PRO-8), so the
 * response says `awaiting_grading` and the result screen tells the child their
 * work is safely in — which is true — rather than showing a number nobody
 * calculated.
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
  if (parsed.data.action === "submit" && trimmed.length < found.item.minChars) {
    return NextResponse.json(
      { error: "too_short", minChars: found.item.minChars },
      { status: 422 },
    );
  }
  if (trimmed.length === 0) {
    return NextResponse.json({ error: "empty_draft" }, { status: 422 });
  }

  if (!(await getConsentState())) {
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

  return NextResponse.json(
    {
      submissionId: record.id,
      draftNo: record.drafts.length,
      draftCount: record.drafts.length,
      charCount: record.drafts[record.drafts.length - 1]?.charCount ?? 0,
      totalActiveMs: record.totalActiveMs,
      correlationId: record.correlationId,
      submittedAt: record.submittedAt,
      status: record.submittedAt ? "awaiting_grading" : "draft_saved",
    },
    { status: parsed.data.action === "submit" ? 201 : 200 },
  );
}
