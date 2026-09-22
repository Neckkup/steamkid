/**
 * AI grading for written work.
 *
 * The contract this module exists to enforce: **a grading call produces a
 * structured verdict or it produces a named failure — never a number nobody
 * can account for.**
 *
 * Three failure modes are given their own status rather than being flattened
 * into a low score, because each one calls for a different response and a score
 * of zero would be a lie about all three:
 *
 * - `blocked_by_safety` — Gemini refused. On a children's product this is an
 *   expected event (`ModelSafetyBlockError` in `src/lib/ai/client.ts` exists for
 *   it). A child must never be told they scored zero because the model declined
 *   to read their answer; this routes to a teacher instead.
 * - `unscorable` — the submission is too short or off-topic to judge, or the
 *   model returned something that does not fit the schema. Also a teacher's
 *   problem, not a grade.
 * - `graded` — every criterion the item is weighted on came back with a level
 *   and a reason.
 *
 * Every verdict, including the failures, is teacher-overridable. `gradeVersion`
 * and `rubricVersion` ride on the trace and belong on the stored row, because a
 * training set that cannot say which rubric produced a label is a training set
 * that cannot be cleaned later.
 */

import { z } from "zod";

import type { WrittenItem } from "@/content";
import { callModel, ModelSafetyBlockError, type CallModelResult } from "@/lib/ai/client";
import type { ModelId } from "@/lib/ai/models";
import type { GradeBand } from "@/lib/observability/langfuse";
import { REDACTION_VERSION } from "@/lib/privacy/redact";
import type { ItemResult } from "@/lib/learning/grade";
import {
  RUBRIC_LEVELS,
  resolveRubric,
  rubricVersionTag,
  type ResolvedRubric,
  type RubricLevel,
  type WrittenSkillCode,
} from "@/lib/learning/rubric";

/**
 * Bumped when the *engine* changes how a level becomes a score — the weighting,
 * the thresholds, the schema. Separate from `rubricVersion`, which moves when
 * the wording of a criterion changes. Two different causes of a score shifting
 * under a child, so two different version numbers.
 */
export const GRADE_VERSION = "ai-grade@1";

/** Prompt names, one per rubric code. Registered in `src/lib/ai/prompts.ts`. */
export const GRADING_PROMPTS: Record<string, string> = {
  SCI_CER_SHORT: "grading/sci-cer-short",
  SCI_CER_LONG: "grading/sci-cer-long",
  SCI_DESIGN_LONG: "grading/sci-design-long",
};

/**
 * The delimiter the child's answer is wrapped in.
 *
 * Paired with `sanitiseLearnerText` below, which removes any occurrence of the
 * closing tag from the child's own text. Without that, a child (or whoever is
 * typing into a child's account) can close the block early and have everything
 * after it read as prompt. The prompt also tells the model in the system turn
 * that content inside this block is never an instruction — defence at both
 * ends, because either one alone has been shown to fail.
 */
const LEARNER_OPEN = "<learner_answer>";
const LEARNER_CLOSE = "</learner_answer>";

/**
 * Strip the closing delimiter out of untrusted text.
 *
 * Deliberately not an escape: there is no legitimate reason for a child writing
 * about pushing a toy car to type `</learner_answer>`, so replacing it costs a
 * real child nothing, while escaping it would leave the literal string in view
 * of the model and invite it to be treated as structure.
 */
export function sanitiseLearnerText(text: string): string {
  return text.replace(/<\/?learner_answer\s*>/gi, " ");
}

export interface GradedCriterion {
  readonly skillCode: WrittenSkillCode;
  readonly level: RubricLevel;
  /** The item's weight for this skill, from `skillWeights`. */
  readonly weight: number;
  /** Why the grader chose this level. Shown to the teacher on the override screen. */
  readonly reason: string;
  /**
   * A short span from the child's answer the level is based on, or `null` when
   * the grader could not point at one. Kept to a fragment on purpose: a teacher
   * needs to see what the AI keyed on, and a fragment is enough to show that
   * while carrying less of the child's writing off our infrastructure. It still
   * passes through the redaction mask before it reaches Langfuse.
   */
  readonly evidence: string | null;
}

export interface VerdictBase {
  readonly itemId: string;
  readonly rubricVersion: string;
  readonly gradeVersion: string;
  readonly model: ModelId;
  readonly promptName: string;
  readonly promptVersion: number;
  /** Null when Langfuse is unconfigured (local checkouts only). */
  readonly traceId: string | null;
  readonly traceUrl: string | null;
  readonly costUsd: number | null;
  readonly latencyMs: number;
}

export type AiVerdict = VerdictBase &
  (
    | {
        readonly status: "graded";
        readonly criteria: readonly GradedCriterion[];
        /** Weighted 0–1, before `difficultyWeight`, same convention as `gradeItem`. */
        readonly normalizedScore: number;
        readonly result: ItemResult;
        /** Thai, addressed to the child. Never the raw reasoning. */
        readonly feedbackToLearner: string;
        /** One concrete thing to do next. */
        readonly nextStep: string;
        /** The child's text tried to instruct the grader. Not a score penalty — a flag. */
        readonly instructionAttempt: boolean;
      }
    | {
        readonly status: "blocked_by_safety";
        readonly reason: string;
        readonly stage: "prompt" | "response";
      }
    | {
        readonly status: "unscorable";
        readonly reason: "too_short" | "off_topic" | "unparseable";
        readonly detail: string;
      }
  );

/**
 * Result bands for a weighted rubric score.
 *
 * Not the `>= 1 is correct` rule the deterministic grader uses, and the
 * difference is not a loosening. A closed item has a ground truth, so exactly
 * right is a real category. Written work has no such point — demanding every
 * criterion at level 3 to be called "correct" would tell a child who wrote a
 * genuinely good answer that they got it wrong, which is both false and the
 * fastest way to stop a ten-year-old writing anything at all.
 *
 * 0.75 is "solid on the criteria that carry the most weight"; 0.35 is "there is
 * something here to build on". Moving these changes every child's score, so
 * treat a change as a prompt-version-grade event: re-run the dataset, post the
 * before/after.
 */
export const RESULT_THRESHOLDS = { correct: 0.75, partial: 0.35 } as const;

export function toResultBand(normalizedScore: number): ItemResult {
  if (normalizedScore >= RESULT_THRESHOLDS.correct) return "correct";
  if (normalizedScore >= RESULT_THRESHOLDS.partial) return "partial";
  return "incorrect";
}

/**
 * Weighted mean of level/3, using the item's own `skillWeights`.
 *
 * Weights are renormalised by their own sum rather than assumed to total 1. The
 * content contract says they sum to 1, but a verdict is not the place to find
 * out that an authoring slip made them sum to 0.9 — that would quietly shave
 * 10% off a child's score with nothing in the trace to explain it.
 */
export function weightedScore(criteria: readonly GradedCriterion[]): number {
  const totalWeight = criteria.reduce((sum, c) => sum + c.weight, 0);
  if (totalWeight <= 0) return 0;
  const weighted = criteria.reduce((sum, c) => sum + (c.level / 3) * c.weight, 0);
  return weighted / totalWeight;
}

/** What the model must return. Mirrored as JSON schema for Gemini below. */
const modelVerdictSchema = z.object({
  criteria: z
    .array(
      z.object({
        skillCode: z.string(),
        level: z.number().int().min(0).max(3),
        reason: z.string().min(1),
        evidence: z.string().nullable().optional(),
      }),
    )
    .min(1),
  feedbackToLearner: z.string().min(1),
  nextStep: z.string().min(1),
  offTopic: z.boolean(),
  tooShortToJudge: z.boolean(),
  instructionAttempt: z.boolean(),
});

/**
 * Gemini's structured-output schema.
 *
 * `skillCode` is an enum of exactly the skills this item is weighted on, not a
 * free string. That is the difference between the model returning the five
 * criteria we asked for and the model helpfully inventing a sixth: a grader
 * that can name its own criteria can also score a child on one nobody agreed
 * to, and the weighting would then silently not add up.
 */
function outputSchemaFor(resolved: ResolvedRubric): Record<string, unknown> {
  const skillCodes = resolved.criteria.map(({ criterion }) => criterion.skillCode);
  return {
    type: "object",
    properties: {
      criteria: {
        type: "array",
        minItems: skillCodes.length,
        maxItems: skillCodes.length,
        items: {
          type: "object",
          properties: {
            skillCode: { type: "string", enum: skillCodes },
            level: { type: "integer", enum: [...RUBRIC_LEVELS] },
            reason: { type: "string" },
            evidence: { type: "string" },
          },
          required: ["skillCode", "level", "reason"],
        },
      },
      feedbackToLearner: { type: "string" },
      nextStep: { type: "string" },
      offTopic: { type: "boolean" },
      tooShortToJudge: { type: "boolean" },
      instructionAttempt: { type: "boolean" },
    },
    required: [
      "criteria",
      "feedbackToLearner",
      "nextStep",
      "offTopic",
      "tooShortToJudge",
      "instructionAttempt",
    ],
  };
}

/** The rubric, rendered into the prompt exactly as the grader must apply it. */
export function renderCriteriaBlock(resolved: ResolvedRubric): string {
  return resolved.criteria
    .map(({ criterion, weight }) => {
      const levels = criterion.levels
        .map((l) => `    ${l.level} = ${l.descriptor}`)
        .join("\n");
      return [
        `- ${criterion.skillCode} (${criterion.label}) — น้ำหนัก ${weight}`,
        levels,
      ].join("\n");
    })
    .join("\n");
}

export interface GradeWrittenOptions {
  readonly item: WrittenItem;
  readonly submissionText: string;
  /** Client-minted `correlation_id`; becomes the Langfuse trace id. */
  readonly correlationId?: string;
  readonly learnerRef?: string;
  readonly sessionId?: string;
  readonly submissionId?: string;
  readonly lessonId?: string;
  readonly attemptNumber?: number;
  readonly gradeBand?: GradeBand;
  readonly consentScopes?: string[];
  /** Langfuse prompt label. `production` unless an eval asks for another. */
  readonly promptLabel?: string;
  /** A/B override. Reported on the verdict so a cost number is attributable. */
  readonly model?: ModelId;
  readonly tags?: string[];
}

/**
 * Grade one written submission.
 *
 * Never throws for a model-side failure: a refusal, a malformed response and a
 * too-short answer all come back as a typed verdict, because the caller's job
 * is to show a child something kind and put the item in a teacher's queue, not
 * to handle three exception types at a route boundary. Wiring errors
 * (`TraceIdentityError`, an unresolvable rubric) still throw — those are bugs,
 * and swallowing them would produce verdicts that cannot be stored.
 */
export async function gradeWritten(options: GradeWrittenOptions): Promise<AiVerdict> {
  const { item, submissionText } = options;
  const resolved = resolveRubric(item);
  const promptName = GRADING_PROMPTS[item.rubricCode];
  if (!promptName) {
    throw new Error(`No grading prompt registered for rubric ${item.rubricCode}.`);
  }

  const rubricVersion = rubricVersionTag(resolved.rubric);
  const learnerText = sanitiseLearnerText(submissionText).trim();

  const base = (result: CallModelResult): VerdictBase => ({
    itemId: item.id,
    rubricVersion,
    gradeVersion: GRADE_VERSION,
    model: result.model,
    promptName: result.promptName,
    promptVersion: result.promptVersion,
    traceId: result.traceId,
    traceUrl: result.traceUrl,
    costUsd: result.cost?.total ?? null,
    latencyMs: result.latencyMs,
  });

  let result: CallModelResult;
  try {
    result = await callModel({
      promptName,
      traceName: `grade.${item.type === "short_text" ? "short" : "long"}-text`,
      promptLabel: options.promptLabel,
      model: options.model,
      correlationId: options.correlationId,
      learnerRef: options.learnerRef,
      sessionId: options.sessionId,
      tags: ["grading", ...(options.tags ?? [])],
      outputSchema: outputSchemaFor(resolved),
      metadata: {
        rubricVersion,
        redactionVersion: REDACTION_VERSION,
        gradeVersion: GRADE_VERSION,
        ...(options.consentScopes ? { consentScopes: options.consentScopes } : {}),
        ...(options.gradeBand ? { gradeBand: options.gradeBand } : {}),
        ...(options.lessonId ? { lessonId: options.lessonId } : {}),
        ...(options.submissionId ? { submissionId: options.submissionId } : {}),
        ...(options.attemptNumber !== undefined
          ? { attemptNumber: options.attemptNumber }
          : {}),
        exerciseId: item.id,
      },
      variables: {
        rubricTitle: resolved.rubric.title,
        graderGuidance: resolved.rubric.graderGuidance.map((g) => `- ${g}`).join("\n"),
        criteriaBlock: renderCriteriaBlock(resolved),
        taskPrompt: item.prompt,
        successCriteria: item.successCriteria.map((c) => `- ${c}`).join("\n"),
        learnerAnswer: learnerText,
      },
    });
  } catch (error) {
    if (error instanceof ModelSafetyBlockError) {
      // No CallModelResult exists — the call never returned one. The verdict
      // still has to name the model and rubric it failed under, because "which
      // prompt version started refusing children's answers" is the first
      // question anyone will ask.
      return {
        itemId: item.id,
        rubricVersion,
        gradeVersion: GRADE_VERSION,
        model: options.model ?? ("unknown" as ModelId),
        promptName,
        promptVersion: 0,
        traceId: options.correlationId ?? null,
        traceUrl: null,
        costUsd: null,
        latencyMs: 0,
        status: "blocked_by_safety",
        reason: error.reason,
        stage: error.stage,
      };
    }
    throw error;
  }

  const parsed = modelVerdictSchema.safeParse(result.json);
  if (!parsed.success) {
    return {
      ...base(result),
      status: "unscorable",
      reason: "unparseable",
      detail: parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")
        .slice(0, 500),
    };
  }

  const verdict = parsed.data;

  if (verdict.tooShortToJudge || verdict.offTopic) {
    return {
      ...base(result),
      status: "unscorable",
      reason: verdict.tooShortToJudge ? "too_short" : "off_topic",
      detail: verdict.feedbackToLearner,
    };
  }

  // The enum in the output schema should make this unreachable, but a schema is
  // a request to the provider, not a guarantee from it. A criterion set that
  // does not match the item's weights would produce a score against weights
  // that were never applied — better an explicit `unscorable` than a plausible
  // wrong number.
  const expected = new Set(resolved.criteria.map(({ criterion }) => criterion.skillCode));
  const returned = new Set(verdict.criteria.map((c) => c.skillCode));
  const mismatch =
    expected.size !== returned.size || [...expected].some((code) => !returned.has(code));
  if (mismatch) {
    return {
      ...base(result),
      status: "unscorable",
      reason: "unparseable",
      detail:
        `criteria mismatch: expected ${[...expected].join(", ")}; ` +
        `got ${[...returned].join(", ")}`,
    };
  }

  const weightBySkill = new Map(
    resolved.criteria.map(({ criterion, weight }) => [criterion.skillCode, weight]),
  );
  const criteria: GradedCriterion[] = verdict.criteria.map((c) => ({
    skillCode: c.skillCode as WrittenSkillCode,
    level: c.level as RubricLevel,
    weight: weightBySkill.get(c.skillCode as WrittenSkillCode) ?? 0,
    reason: c.reason,
    evidence: c.evidence?.trim() ? c.evidence.trim() : null,
  }));

  const normalizedScore = weightedScore(criteria);

  return {
    ...base(result),
    status: "graded",
    criteria,
    normalizedScore,
    result: toResultBand(normalizedScore),
    feedbackToLearner: verdict.feedbackToLearner,
    nextStep: verdict.nextStep,
    instructionAttempt: verdict.instructionAttempt,
  };
}

/** Delimiters, exported so the prompt registry and its tests agree on them. */
export const LEARNER_DELIMITERS = { open: LEARNER_OPEN, close: LEARNER_CLOSE } as const;
