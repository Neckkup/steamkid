/**
 * The join between the grading engine and the path a child's work travels
 * (PRO-115).
 *
 * `ai-grade.ts` has produced structured verdicts since PRO-8 and
 * `verdict-store.ts` has had somewhere to put them since PRO-76, but nothing in
 * `src/app` called either one: `/api/attempts` answered `pending_ai` for every
 * written item and `/api/submissions` answered `awaiting_grading`, so a child
 * who pressed send saw "a teacher will look at this" forever and the teacher
 * queue was filled by fixtures. This module is the missing call, and the order
 * it makes the checks in is the whole design:
 *
 *   1. **Consent before cost.** No `ai_grading` grant, no model call. The
 *      database enforces the same rule again inside `save()`; this check is not
 *      the guarantee, it is the one that stops us paying for a call we would
 *      then have to throw away.
 *   2. **Somewhere to store it before anything is graded.** A score a teacher
 *      cannot open and correct is not a score this company ships, so if there
 *      is no database, or the cookie matches no `app.learner` row, the grader
 *      is never called and the child gets exactly the honest screen they got
 *      before. Verdict-in-a-response-only was never an option.
 *   3. **A refusal is routed, not scored.** `blocked_by_safety` and
 *      `unscorable` come back as `awaiting_teacher`, are stored with a NULL
 *      score by CHECK constraint, and sort to the front of the teacher queue
 *      (`awaitsTeacher` in `review-queue.ts`). A child is never told they
 *      scored zero because the model declined to read their answer.
 *   4. **Every failure lands on yesterday's behaviour.** Timeout, model error,
 *      store error: the caller gets `pending_ai` with a named reason, the
 *      child's work is already saved, and nothing is invented.
 *
 * On the child's latency, which is the part worth arguing about: the grading
 * call runs inside the child's request, bounded by `AI_GRADING_BUDGET_MS`. Past
 * the budget the *screen* stops waiting, but the call is not cancelled — its
 * verdict is still stored after the response, so the work is not wasted, the
 * teacher queue still gets the row, and the trace still lands. A child is
 * therefore never held longer than the budget, and we never pay for a grade we
 * then discard. `docs/runbooks/ai-observability.md` warns at a grading p95 of
 * 15s, so a budget above that would mean the normal case is already an alert.
 *
 * Rollback is `AI_GRADING_INLINE=off`: one environment variable, no deploy, and
 * the routes answer exactly as they did before this file existed.
 */

import type { WrittenItem } from "@/content";
import { resolveLearnerId } from "@/lib/events/learner";
import { env } from "@/lib/env";
import { REDACTION_VERSION } from "@/lib/privacy/redact";

import { gradeWritten, sanitiseLearnerText, type AiVerdict } from "./ai-grade";
import type { ItemResult } from "./grade";
import { hasScope } from "./session";
import type { ConsentState } from "./store";
import {
  ConsentMissing,
  VERDICT_CONSENT_SCOPE,
  type EffectiveVerdict,
  type StoredVerdict,
  type VerdictStore,
  type VerdictSubjectType,
} from "./verdict-store";
import { resolveVerdictDb, resolveVerdictStore } from "./verdict-runtime";

/**
 * Why a child is not getting AI feedback on this submission.
 *
 * Every one of these is reported to the screen so it can say something true.
 * The alternative — a single `pending_ai` with no reason — is what made the old
 * behaviour indistinguishable from a broken grader.
 */
export type PendingReason =
  /** No guardian grant for `ai_grading`. Nothing was sent to any model. */
  | "consent_missing"
  /** `AI_GRADING_INLINE=off`. The kill switch is pulled. */
  | "grader_disabled"
  /** No database, so no verdict could be stored, so nothing was graded. */
  | "grader_unavailable"
  /** The cookie matches no `app.learner` row. Fail closed, same as consent. */
  | "unknown_learner"
  /** Over `AI_GRADING_BUDGET_MS`. The verdict is still being stored. */
  | "grader_timeout"
  /** The call or the write failed. Logged; the child's work is safe. */
  | "grader_failed";

export type AwaitingTeacherReason =
  | "blocked_by_safety"
  | "too_short"
  | "off_topic"
  | "unparseable";

export type WrittenGradeOutcome =
  | {
      readonly kind: "graded";
      readonly verdictId: string;
      readonly result: ItemResult;
      readonly normalizedScore: number;
      /** Thai, addressed to the child. Safe to render. */
      readonly feedbackToLearner: string;
      readonly nextStep: string;
    }
  | {
      readonly kind: "awaiting_teacher";
      readonly verdictId: string;
      readonly reason: AwaitingTeacherReason;
    }
  | { readonly kind: "pending_ai"; readonly reason: PendingReason };

export interface GradeRequestInput {
  readonly item: WrittenItem;
  /** Exactly what the child typed. Sanitised here, never trusted as prompt. */
  readonly submissionText: string;
  /** The cookie value — `app.learner.public_ref`, never an internal id. */
  readonly learnerRef: string;
  readonly consent: ConsentState | null;
  /** Minted by the route. Becomes both the trace id and `correlation_id`. */
  readonly correlationId: string;
  readonly subjectType: VerdictSubjectType;
  /** `app.attempt.id` / `app.submission.id` as the route knows it. */
  readonly subjectId: string;
  readonly attemptNumber: number;
  readonly lessonId?: string;
  /** `events.session.id`, so one sitting reads as one Langfuse session. */
  readonly sessionId?: string;
  /**
   * `after` from `next/server`, passed in rather than imported.
   *
   * Only used on the timeout path, to finish storing a verdict the child is no
   * longer waiting for. Injected because this module is also reached from
   * tests and scripts, where there is no request to run after.
   */
  readonly scheduleAfterResponse?: (task: () => void | Promise<void>) => void;
}

function pending(reason: PendingReason): WrittenGradeOutcome {
  return { kind: "pending_ai", reason };
}

/**
 * Grade one piece of written work and store the verdict.
 *
 * Never throws. A caller is a route handler holding a child's saved answer, and
 * there is no failure here that should turn into a 500 on a request whose real
 * job — keeping the work — already succeeded.
 */
export async function gradeForRequest(input: GradeRequestInput): Promise<WrittenGradeOutcome> {
  if (!hasScope(input.consent, VERDICT_CONSENT_SCOPE)) return pending("consent_missing");
  if (env.AI_GRADING_INLINE === "off") return pending("grader_disabled");

  const store = resolveVerdictStore();
  const db = resolveVerdictDb();
  if (!store || !db) return pending("grader_unavailable");

  const learnerId = await resolveLearnerId(db, input.learnerRef).catch(() => null);
  if (!learnerId) return pending("unknown_learner");

  // Started here, awaited below. Held as one promise so the timeout path can
  // hand the *same* in-flight call to `after()` instead of starting a second.
  const settled = gradeAndStore(store, learnerId, input);

  const budget = env.AI_GRADING_BUDGET_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), budget);
  });

  try {
    const finished = await Promise.race([settled, timeout]);
    if (finished === "timeout") {
      scheduleLateStore(settled, input.scheduleAfterResponse);
      return pending("grader_timeout");
    }
    if (!finished.ok) {
      reportGradingFailure(input, finished.error);
      return pending(finished.error instanceof ConsentMissing ? "consent_missing" : "grader_failed");
    }
    return toOutcome(finished.stored);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The newest verdict for one piece of a child's own work, corrections applied.
 *
 * Here rather than on the screens so no page has to hold an internal learner
 * id: it takes the same cookie ref the rest of the product uses and does the
 * exchange itself. The learner scope is not optional — `latestForSubject` would
 * happily return another child's verdict to anyone who guessed an id.
 */
export async function latestVerdictFor(
  learnerRef: string,
  subjectType: VerdictSubjectType,
  subjectId: string,
): Promise<EffectiveVerdict | null> {
  const store = resolveVerdictStore();
  const db = resolveVerdictDb();
  if (!store || !db) return null;

  const learnerId = await resolveLearnerId(db, learnerRef).catch(() => null);
  if (!learnerId) return null;

  return store.latestForLearnerSubject(learnerId, subjectType, subjectId);
}

type GradeAndStoreResult =
  | { readonly ok: true; readonly stored: StoredVerdict }
  | { readonly ok: false; readonly error: unknown };

/**
 * Call the model, then write the row. Resolves rather than rejects, so the
 * race above cannot leave a rejected promise unhandled when the budget wins.
 */
async function gradeAndStore(
  store: VerdictStore,
  learnerId: string,
  input: GradeRequestInput,
): Promise<GradeAndStoreResult> {
  try {
    const verdict = await gradeWritten({
      item: input.item,
      submissionText: input.submissionText,
      correlationId: input.correlationId,
      learnerRef: input.learnerRef,
      sessionId: input.sessionId,
      submissionId: input.subjectType === "submission" ? input.subjectId : undefined,
      lessonId: input.lessonId,
      attemptNumber: input.attemptNumber,
      consentScopes: [...(input.consent?.scopes ?? [])],
      tags: [input.subjectType],
    });

    const stored = await store.save({
      verdict,
      learnerId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      attemptNumber: input.attemptNumber,
      correlationId: input.correlationId,
      inputSnapshot: inputSnapshot(input, verdict),
      redactionVersion: REDACTION_VERSION,
    });

    return { ok: true, stored };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * What the model was actually given, under the key the teacher screen reads.
 *
 * `answer` is the first key `answerText()` in `review-queue.ts` tries, and that
 * file asked the eventual writer to standardise on it rather than leave a
 * teacher looking at raw JSON. The text is the sanitised form — the closing
 * delimiter stripped — because that, not the original keystrokes, is what
 * reached Gemini, and a teacher auditing the machine needs the machine's input.
 */
function inputSnapshot(input: GradeRequestInput, verdict: AiVerdict): unknown {
  return {
    answer: sanitiseLearnerText(input.submissionText).trim(),
    itemId: input.item.id,
    rubricVersion: verdict.rubricVersion,
    promptName: verdict.promptName,
    promptVersion: verdict.promptVersion,
  };
}

function toOutcome(stored: StoredVerdict): WrittenGradeOutcome {
  if (
    stored.status === "graded" &&
    stored.result !== null &&
    stored.normalizedScore !== null &&
    stored.feedbackToLearner !== null &&
    stored.nextStep !== null
  ) {
    return {
      kind: "graded",
      verdictId: stored.id,
      result: stored.result,
      normalizedScore: stored.normalizedScore,
      feedbackToLearner: stored.feedbackToLearner,
      nextStep: stored.nextStep,
    };
  }

  return {
    kind: "awaiting_teacher",
    verdictId: stored.id,
    reason: stored.unscorableReason ?? "blocked_by_safety",
  };
}

/**
 * Finish storing a verdict the child stopped waiting for.
 *
 * Without a scheduler the promise is simply left to settle on its own, which is
 * what happens in a test or a script; in a serverless request that is not
 * reliable, which is exactly what `after()` exists for.
 */
function scheduleLateStore(
  settled: Promise<GradeAndStoreResult>,
  schedule: GradeRequestInput["scheduleAfterResponse"],
): void {
  const finish = async () => {
    const result = await settled;
    if (!result.ok) reportGradingFailure(null, result.error);
  };

  if (!schedule) {
    void finish();
    return;
  }

  try {
    schedule(finish);
  } catch {
    // No request context to run after (a test, a script). The promise still
    // settles; it just is not guaranteed to outlive the process.
    void finish();
  }
}

/**
 * A grading failure is an operations event, not a child-facing one.
 *
 * Deliberately not `throw`: the child's answer is already stored and the screen
 * has a true thing to say. What must not happen is the failure being silent, so
 * it goes to stderr, where the platform's log drain and Sentry's console
 * integration both pick it up. No answer text is logged — only ids.
 */
function reportGradingFailure(input: GradeRequestInput | null, error: unknown): void {
  const where = input
    ? `item=${input.item.id} subject=${input.subjectType}:${input.subjectId} correlation=${input.correlationId}`
    : "late store after response";
  console.error(`[grading] verdict not stored (${where}):`, error);
}
