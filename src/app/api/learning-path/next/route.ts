/**
 * `GET /api/learning-path/next` — next recommended lesson for the current learner.
 *
 * Guards:
 *   1. Consent required (`behaviour_events` scope covers recommendation;
 *      the engine itself is rule-based and calls no model).
 *   2. `LEARNING_PATH_ENABLED=off` returns a `503` kill switch so a bad
 *      rollout can be reverted in seconds without a deploy.
 *   3. No database → 503. A recommendation that cannot be stored is a
 *      recommendation that cannot be traced; "no database" is never silently
 *      degraded to a guess.
 */

import { NextResponse } from "next/server";

import { resolveLearnerId } from "@/lib/events/learner";
import { env } from "@/lib/env";
import { getLearnerRef, getConsentState } from "@/lib/learning/session";
import { uuidv7 } from "@/lib/ids";
import { selectNextStep } from "@/lib/learning/path-engine";
import { resolvePathDb } from "@/lib/learning/path-runtime";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  if (env.LEARNING_PATH_ENABLED === "off") {
    return NextResponse.json({ error: "learning_path_disabled" }, { status: 503 });
  }

  const consent = await getConsentState();
  if (!consent) {
    return NextResponse.json({ error: "consent_required" }, { status: 403 });
  }

  const learnerRef = await getLearnerRef();
  if (!learnerRef) {
    return NextResponse.json({ error: "learner_not_found" }, { status: 404 });
  }

  const db = resolvePathDb();
  if (!db) {
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }

  const learnerId = await resolveLearnerId(db, learnerRef);
  if (!learnerId) {
    return NextResponse.json({ error: "learner_not_found" }, { status: 404 });
  }

  const correlationId = uuidv7();
  const step = await selectNextStep(db, learnerId, learnerRef, correlationId);
  if (!step) {
    return NextResponse.json({ error: "no_recommendation" }, { status: 404 });
  }

  return NextResponse.json({
    stepId: step.stepId,
    targetType: step.targetType,
    targetId: step.targetId,
    reason: step.reason,
    langfuseTraceId: step.langfuseTraceId,
  });
}
