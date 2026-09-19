/**
 * Deterministic grading — the half of the product that does not need a model.
 *
 * PRO-3 `mvp-scope` keeps closed items in the MVP for a specific reason: they
 * have a ground truth, so they are the calibration baseline the AI grader is
 * later checked against. That only works if the deterministic score is computed
 * here, from the item definition, and never by the model.
 *
 * Written items (`short_text`, `long_text`) are deliberately **not** graded
 * here. They return `pending_ai`, and the result screen says so in words a child
 * understands. Inventing a score for them would put a fabricated number in front
 * of a child and into the training set at the same time.
 */

import type { ClosedItem, ExerciseItem } from "@/content";

/** `item.result_shown.result` in the event registry. */
export type ItemResult = "correct" | "partial" | "incorrect";

export type GradeOutcome =
  | {
      readonly status: "graded";
      readonly result: ItemResult;
      /** 0–1 before `difficultyWeight` is applied. */
      readonly normalizedScore: number;
      readonly source: "deterministic";
      readonly explanation: string;
    }
  | {
      readonly status: "pending_ai";
      readonly source: "ai";
    };

/** The answer shapes a child's device may send, one per closed item type. */
export type ClosedAnswer =
  | { readonly type: "mcq"; readonly choiceId: string }
  | { readonly type: "numeric"; readonly value: number }
  | { readonly type: "ordering"; readonly order: readonly string[] };

export type ItemAnswer = ClosedAnswer | { readonly type: "text"; readonly text: string };

export function isClosedItem(item: ExerciseItem): item is ClosedItem {
  return item.type === "mcq" || item.type === "numeric" || item.type === "ordering";
}

export function gradeItem(item: ExerciseItem, answer: ItemAnswer): GradeOutcome {
  if (!isClosedItem(item)) return { status: "pending_ai", source: "ai" };

  const normalizedScore = scoreClosed(item, answer);
  return {
    status: "graded",
    result: toResult(normalizedScore),
    normalizedScore,
    source: "deterministic",
    explanation: item.explanation,
  };
}

/**
 * A score of exactly 1 is correct and 0 is incorrect. Everything between is
 * `partial`, which only `ordering` can produce — getting three of four steps in
 * the right order is not the same as getting none of them, and a child who is
 * told "incorrect" for it learns the wrong thing about their own work.
 */
function toResult(normalizedScore: number): ItemResult {
  if (normalizedScore >= 1) return "correct";
  if (normalizedScore > 0) return "partial";
  return "incorrect";
}

function scoreClosed(item: ClosedItem, answer: ItemAnswer): number {
  switch (item.type) {
    case "mcq":
      return answer.type === "mcq" && answer.choiceId === item.correctChoiceId ? 1 : 0;

    case "numeric":
      if (answer.type !== "numeric" || !Number.isFinite(answer.value)) return 0;
      return Math.abs(answer.value - item.correctValue) <= item.tolerance ? 1 : 0;

    case "ordering":
      return answer.type === "ordering" ? kendallTauScore(answer.order, item.correctOrder) : 0;
  }
}

/**
 * Normalised Kendall tau, the measure PRO-3's skill map names for
 * `CT.DECOMPOSE_SEQUENCE`: the share of item pairs the child put in the same
 * relative order as the reference, mapped from tau's [-1, 1] onto [0, 1].
 *
 * Pair-counting rather than position-matching because one item inserted in the
 * wrong place shifts every position after it; a child who has the sequence
 * almost right should not score zero for an off-by-one.
 */
export function kendallTauScore(
  submitted: readonly string[],
  reference: readonly string[],
): number {
  if (submitted.length !== reference.length) return 0;

  const rank = new Map(reference.map((id, index) => [id, index]));
  const ranks: number[] = [];
  for (const id of submitted) {
    const position = rank.get(id);
    // An id the item never offered: not a partially right answer, a broken one.
    if (position === undefined) return 0;
    ranks.push(position);
  }
  if (new Set(ranks).size !== ranks.length) return 0;

  const pairs = (ranks.length * (ranks.length - 1)) / 2;
  if (pairs === 0) return 1;

  let concordant = 0;
  for (let i = 0; i < ranks.length; i += 1) {
    for (let j = i + 1; j < ranks.length; j += 1) {
      if (ranks[i]! < ranks[j]!) concordant += 1;
    }
  }

  const tau = (2 * concordant - pairs) / pairs;
  return (tau + 1) / 2;
}
