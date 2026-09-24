/**
 * Learning path rule engine — PRO-10.
 *
 * Returns the next recommended lesson for a learner based on their skill state,
 * then writes a `learning_path_step` row and emits a Langfuse trace.
 *
 * Design contract:
 *
 *   - Rules first, model later. The seam is `selectRuleBasedStep`. When our own
 *     model is ready, replace the body without changing the caller or the output
 *     shape. `PATH_POLICY_VERSION` moves, and the reason JSON moves with it.
 *   - Every recommendation carries a human-readable reason for the child, the
 *     teacher, and the Langfuse trace.
 *   - Rollback is `LEARNING_PATH_ENABLED=off`. One env var, no deploy.
 *   - Content is loaded from `src/content` today; the loader is async so the
 *     swap to `app.lesson` SQL is a change of one import, not a rewrite.
 */

import { randomUUID } from "node:crypto";

import { listLessons } from "@/content";
import type { Lesson } from "@/content";
import type { SqlExecutor } from "@/lib/db/sql";
import { uuidv7 } from "@/lib/ids";
import { getLangfuse } from "@/lib/observability/langfuse";

/** Identifies which rule set produced this step. Bump when rules change. */
export const PATH_POLICY_VERSION = "rules@1";

/**
 * The structured reason that rides on the `learning_path_step` row and the
 * Langfuse trace. Everything in here must be safe to store externally: no PII,
 * no learner name, no raw answer text.
 */
export interface StepReason {
  /** Always equal to `PATH_POLICY_VERSION`. Stored so old rows stay interpretable. */
  readonly ruleVersion: string;
  readonly targetTitle: string;
  readonly selectionRule:
    | "cold_start_first_lesson"
    | "weakest_skill_match"
    | "progress_next_lesson"
    | "fallback_first_unstarted";
  /** Weakest skill that drove selection, null on cold start. */
  readonly triggerSkill: { readonly skillCode: string; readonly mastery: number } | null;
  /** Shown to the child in the product. Keep it encouraging and in Thai. */
  readonly forChild: string;
  /** Shown to the teacher on the review screen. English, factual. */
  readonly forTeacher: string;
}

export interface PathStep {
  readonly stepId: string;
  readonly targetType: "lesson";
  readonly targetId: string;
  readonly reason: StepReason;
  readonly langfuseTraceId: string | null;
  readonly correlationId: string;
}

interface SkillRow {
  skill_code: string;
  mastery: number;
  confidence: number;
  evidence_count: number;
}

interface RecentStep {
  target_id: string;
  status: string;
}

const CONFIDENCE_FLOOR = 0.4;
const RECENT_STEP_LIMIT = 5;

/**
 * Select the next lesson for this learner and record it.
 *
 * Returns null only when the content catalog is empty or the database write
 * fails — callers should treat null as "no recommendation available yet."
 */
export async function selectNextStep(
  sql: SqlExecutor,
  learnerId: string,
  learnerRef: string,
  correlationId: string,
): Promise<PathStep | null> {
  const [lessons, skillRows, recentSteps] = await Promise.all([
    listLessons(),
    loadSkillState(sql, learnerId),
    loadRecentSteps(sql, learnerId),
  ]);

  if (lessons.length === 0) return null;

  const recentTargetIds = new Set(recentSteps.map((s) => s.target_id));
  const step = selectRuleBasedStep(lessons, skillRows, recentTargetIds);
  if (!step) return null;

  const stepId = uuidv7();
  const traceId = await emitTrace(learnerRef, learnerId, correlationId, step);

  await writeStep(sql, {
    stepId,
    learnerId,
    targetType: "lesson",
    targetId: step.lesson.id,
    reason: step.reason,
    correlationId,
    langfuseTraceId: traceId,
  });

  return {
    stepId,
    targetType: "lesson",
    targetId: step.lesson.id,
    reason: step.reason,
    langfuseTraceId: traceId,
    correlationId,
  };
}

// ---------------------------------------------------------------------------
// Selection logic — replace this body when our own model is ready
// ---------------------------------------------------------------------------

interface Selection {
  lesson: Lesson;
  reason: StepReason;
}

function selectRuleBasedStep(
  lessons: readonly Lesson[],
  skillRows: SkillRow[],
  recentTargetIds: Set<string>,
): Selection | null {
  const available = lessons.filter((l) => !recentTargetIds.has(l.id));
  const candidates = available.length > 0 ? available : lessons;

  // Cold start: no skill evidence yet. Offer the first lesson in teaching order.
  if (skillRows.length === 0) {
    const lesson = candidates[0];
    if (!lesson) return null;
    return {
      lesson,
      reason: {
        ruleVersion: PATH_POLICY_VERSION,
        targetTitle: lesson.title,
        selectionRule: "cold_start_first_lesson",
        triggerSkill: null,
        forChild: `เริ่มต้นด้วย "${lesson.title}" กันเลย!`,
        forTeacher: `Cold start — no skill evidence yet. Offering lesson 1 (${lesson.slug}).`,
      },
    };
  }

  // Weakest skill: find the cognitive skill with the most room to grow.
  const confidentSkills = skillRows.filter((s) => s.confidence >= CONFIDENCE_FLOOR);
  const sorted = [...confidentSkills].sort((a, b) => a.mastery - b.mastery);
  const weakest = sorted[0];

  if (weakest) {
    // Find a lesson that covers this skill.
    const match = candidates.find((l) => l.skillTags.includes(weakest.skill_code));
    if (match) {
      return {
        lesson: match,
        reason: {
          ruleVersion: PATH_POLICY_VERSION,
          targetTitle: match.title,
          selectionRule: "weakest_skill_match",
          triggerSkill: { skillCode: weakest.skill_code, mastery: weakest.mastery },
          forChild: `ลองฝึก "${match.title}" เพื่อพัฒนาทักษะที่กำลังเติบโต!`,
          forTeacher:
            `Weakest confident skill: ${weakest.skill_code} (mastery=${weakest.mastery.toFixed(2)}). ` +
            `Matched lesson: ${match.slug}.`,
        },
      };
    }
  }

  // Progress: no skill match found — offer the next unstarted lesson in order.
  const next = candidates[0];
  if (!next) return null;
  return {
    lesson: next,
    reason: {
      ruleVersion: PATH_POLICY_VERSION,
      targetTitle: next.title,
      selectionRule: weakest ? "fallback_first_unstarted" : "progress_next_lesson",
      triggerSkill: weakest
        ? { skillCode: weakest.skill_code, mastery: weakest.mastery }
        : null,
      forChild: `ไปต่อกับ "${next.title}" กันเลย!`,
      forTeacher:
        weakest
          ? `Weakest skill ${weakest.skill_code} has no matching lesson; falling back to next unstarted.`
          : `No confident skill data; progressing to next unstarted lesson (${next.slug}).`,
    },
  };
}

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

async function loadSkillState(sql: SqlExecutor, learnerId: string): Promise<SkillRow[]> {
  const { rows } = await sql.query<SkillRow>(
    `SELECT sk.skill_code, ss.mastery::float, ss.confidence::float, ss.evidence_count
     FROM app.skill_state ss
     JOIN app.skill sk ON sk.skill_code = ss.skill_code
     WHERE ss.learner_id = $1::uuid AND sk.kind = 'cognitive'
     ORDER BY ss.mastery ASC`,
    [learnerId],
  );
  return rows;
}

async function loadRecentSteps(sql: SqlExecutor, learnerId: string): Promise<RecentStep[]> {
  const { rows } = await sql.query<RecentStep>(
    `SELECT target_id::text, status
     FROM app.learning_path_step
     WHERE learner_id = $1::uuid AND target_type = 'lesson'
     ORDER BY offered_at DESC
     LIMIT $2`,
    [learnerId, RECENT_STEP_LIMIT],
  );
  return rows;
}

async function writeStep(
  sql: SqlExecutor,
  params: {
    stepId: string;
    learnerId: string;
    targetType: string;
    targetId: string;
    reason: StepReason;
    correlationId: string;
    langfuseTraceId: string | null;
  },
): Promise<void> {
  // rank = max(existing rank) + 1, so recommendations accumulate in order.
  const { rows } = await sql.query<{ next_rank: number }>(
    `SELECT COALESCE(MAX(rank), 0) + 1 AS next_rank
     FROM app.learning_path_step
     WHERE learner_id = $1::uuid`,
    [params.learnerId],
  );
  const rank = rows[0]?.next_rank ?? 1;

  await sql.query(
    `INSERT INTO app.learning_path_step
       (id, learner_id, target_type, target_id, reason, policy_version, rank,
        status, langfuse_trace_id, correlation_id)
     VALUES ($1::uuid, $2::uuid, $3::text, $4::uuid, $5::jsonb, $6::text, $7::int,
             'offered', $8::uuid, $9::uuid)`,
    [
      params.stepId,
      params.learnerId,
      params.targetType,
      params.targetId,
      JSON.stringify(params.reason),
      PATH_POLICY_VERSION,
      rank,
      params.langfuseTraceId,
      params.correlationId,
    ],
  );
}

// ---------------------------------------------------------------------------
// Langfuse trace — non-LLM, but every path decision must be observable
// ---------------------------------------------------------------------------

async function emitTrace(
  learnerRef: string,
  learnerId: string,
  correlationId: string,
  selection: Selection,
): Promise<string | null> {
  const langfuse = getLangfuse();
  if (!langfuse) return null;

  const traceId = randomUUID();

  const trace = langfuse.trace({
    id: traceId,
    name: "learning-path.select-next-step",
    userId: learnerRef,
    input: { policy: PATH_POLICY_VERSION },
    output: {
      targetId: selection.lesson.id,
      targetSlug: selection.lesson.slug,
      reason: selection.reason,
    },
    tags: ["learning-path", "rules", PATH_POLICY_VERSION],
    metadata: { correlationId },
  });

  trace.span({
    name: "rule-engine",
    input: { policy: PATH_POLICY_VERSION, targetTitle: selection.lesson.title },
    output: { rule: selection.reason.selectionRule },
  });

  await langfuse.flushAsync();
  return traceId;
}
