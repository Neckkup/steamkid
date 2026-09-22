/**
 * The projection of an exercise item that is safe to send to a browser.
 *
 * The answer key never crosses this line. `correctChoiceId`, `correctValue`,
 * `correctOrder` and the explanation stay on the server; grading happens in
 * `POST /api/attempts` and the explanation comes back with the result. A child
 * who opens devtools and finds the answers is not cheating us out of a score —
 * they are putting a hole in the evidence the whole growth model is built on.
 */

import type { ExerciseItem, Lesson, SkillWeights } from "./types";

interface PublicItemBase {
  readonly id: string;
  readonly prompt: string;
  readonly difficulty: 1 | 2 | 3;
  readonly maxAttempts: number;
  readonly hintTexts: readonly string[];
  readonly skillWeights: SkillWeights;
}

interface PublicWrittenBase extends PublicItemBase {
  readonly successCriteria: readonly string[];
  readonly minChars: number;
}

/** The one long-form piece of work per lesson — its own screen, graded by AI. */
export type PublicLongTextItem = PublicWrittenBase & { readonly type: "long_text" };

export type PublicItem =
  | (PublicItemBase & {
      readonly type: "mcq";
      readonly choices: readonly { readonly id: string; readonly label: string }[];
    })
  | (PublicItemBase & { readonly type: "numeric"; readonly unit: string })
  | (PublicItemBase & {
      readonly type: "ordering";
      readonly options: readonly { readonly id: string; readonly label: string }[];
    })
  | (PublicWrittenBase & { readonly type: "short_text" })
  | PublicLongTextItem;

export function toPublicItem(item: ExerciseItem): PublicItem {
  const base: PublicItemBase = {
    id: item.id,
    prompt: item.prompt,
    difficulty: item.difficulty,
    maxAttempts: item.maxAttempts,
    hintTexts: item.hintTexts,
    skillWeights: item.skillWeights,
  };

  switch (item.type) {
    case "mcq":
      return { ...base, type: "mcq", choices: item.choices };
    case "numeric":
      return { ...base, type: "numeric", unit: item.unit };
    case "ordering":
      return { ...base, type: "ordering", options: item.options };
    case "short_text":
      return {
        ...base,
        type: "short_text",
        successCriteria: item.successCriteria,
        minChars: item.minChars,
      };
    case "long_text":
      return {
        ...base,
        type: "long_text",
        successCriteria: item.successCriteria,
        minChars: item.minChars,
      };
  }
}

/**
 * The one predicate that decides what the practice runner asks.
 *
 * `practiceItems` and `lessonWorkload` both go through it so the count a lesson
 * card promises cannot drift from the "ข้อ 1 จาก N" a child then sees (PRO-40).
 */
const isPracticeItem = (item: ExerciseItem): boolean => item.type !== "long_text";

/** The items a child answers inline on the practice screen. */
export function practiceItems(lesson: Lesson): readonly PublicItem[] {
  return lesson.items.filter(isPracticeItem).map(toPublicItem);
}

/** What a lesson actually asks of a child: inline questions, plus any project. */
export function lessonWorkload(lesson: Lesson): {
  readonly questionCount: number;
  readonly projectCount: number;
} {
  const questionCount = lesson.items.filter(isPracticeItem).length;
  return { questionCount, projectCount: lesson.items.length - questionCount };
}

/** The one long-form piece of work per lesson, handled on its own screen. */
export function projectItem(lesson: Lesson): PublicLongTextItem | undefined {
  const item = lesson.items.find((candidate) => candidate.type === "long_text");
  if (!item) return undefined;

  const publicItem = toPublicItem(item);
  return publicItem.type === "long_text" ? publicItem : undefined;
}
