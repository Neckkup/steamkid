import { NextResponse } from "next/server";
import { z } from "zod";

import { RUBRIC_LEVELS } from "@/lib/learning/rubric";
import { getTeacherIdentity } from "@/lib/learning/teacher-session";
import { resolveVerdictStore } from "@/lib/learning/verdict-runtime";
import { OverrideRejected, type CorrectionReasonCode } from "@/lib/learning/verdict-store";

export const dynamic = "force-dynamic";

/**
 * One skill, not a whole paper.
 *
 * A teacher disagrees with the model about `SCI.HYPOTHESIS`, not about the
 * submission. Taking a whole score map here is what made the old shape
 * overwrite four levels to change one, and it is also how a stale screen
 * silently reverts a colleague's correction.
 */
const overrideBody = z.object({
  skillCode: z.string().min(1).max(64),
  correctedLevel: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  reasonCode: z.enum([
    "too_harsh",
    "too_lenient",
    "missed_criterion",
    "wrong_reasoning",
    "other",
  ]),
  /**
   * What the teacher typed. Optional in the contract because a correction that
   * is refused for want of a sentence is a correction that does not get made —
   * but the screen should ask, because the sentence is the part that explains
   * *why* the model was wrong rather than only *that* it was.
   */
  note: z.string().max(2_000).optional(),
});

/**
 * `POST /api/verdicts/:id/override` — a teacher corrects one skill on one AI verdict.
 *
 * Every write here is an append. Nothing in this handler can change what the AI
 * said: `original_level` is read out of `app.ai_verdict_criterion` inside the
 * INSERT, so the stored pair (what the model said, what the teacher said) is
 * true even if the request body claims otherwise. That pair is the training
 * label this endpoint exists to collect; a correction stored as an overwrite
 * keeps the right answer and loses where the model went wrong.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid_verdict_id" }, { status: 400 });
  }

  const teacher = await getTeacherIdentity();
  if (teacher.kind === "unavailable") {
    // No teacher sign-in in this tier, so there is no such thing as an
    // authorised caller. 404 rather than 401: the route does not exist here.
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (teacher.kind === "anonymous") {
    return NextResponse.json({ error: "teacher_required" }, { status: 401 });
  }

  const parsed = overrideBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const store = resolveVerdictStore();
  if (!store) {
    // Refusing is the only honest answer: a correction accepted and dropped is
    // a label we can never collect again.
    return NextResponse.json({ error: "database_unavailable" }, { status: 503 });
  }

  try {
    const override = await store.recordOverride({
      verdictId: id,
      teacherUserId: teacher.userId,
      skillCode: parsed.data.skillCode,
      correctedLevel: parsed.data.correctedLevel as (typeof RUBRIC_LEVELS)[number],
      reasonCode: parsed.data.reasonCode as CorrectionReasonCode,
      note: parsed.data.note ?? null,
    });

    // The whole verdict comes back with the correction applied, so the screen
    // renders what a child would now see rather than patching its own copy.
    const effective = await store.getEffective(id);

    return NextResponse.json(
      {
        override: {
          id: override.id,
          skillCode: override.skillCode,
          originalLevel: override.originalLevel,
          correctedLevel: override.correctedLevel,
          reasonCode: override.reasonCode,
          createdAt: override.createdAt,
        },
        verdict: effective,
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof OverrideRejected) {
      const status = error.failure === "not_a_teacher" ? 403 : 404;
      return NextResponse.json({ error: error.failure }, { status });
    }
    throw error;
  }
}

/**
 * `GET /api/verdicts/:id/override` — the verdict and every correction on it.
 *
 * Every correction, not the latest: a teacher who changed their mind twice is
 * two rows, and the disagreement between them is itself signal. The teacher
 * screen shows the history for the same reason.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid_verdict_id" }, { status: 400 });
  }

  const teacher = await getTeacherIdentity();
  if (teacher.kind === "unavailable") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (teacher.kind === "anonymous") {
    return NextResponse.json({ error: "teacher_required" }, { status: 401 });
  }

  const store = resolveVerdictStore();
  if (!store) {
    return NextResponse.json({ error: "database_unavailable" }, { status: 503 });
  }

  const verdict = await store.getEffective(id);
  if (!verdict) {
    return NextResponse.json({ error: "unknown_verdict" }, { status: 404 });
  }

  return NextResponse.json({ verdict, overrides: await store.listOverrides(id) });
}
