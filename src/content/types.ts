/**
 * The shape of a course, as the screens read it.
 *
 * Where this lives, and why it is not in the database yet: PRO-3 `data-schema`
 * puts courses, lessons and exercise items in `app.course` / `app.lesson` /
 * `app.exercise_item`, and Backend creates those tables in PRO-7. Until the
 * migration exists there is no Postgres for this checkout to read, so the unit
 * is authored here as typed content and loaded through `src/content/index.ts`.
 *
 * Two rules keep that from becoming a lie the UI tells:
 *
 *   1. **Ids are real UUIDs.** Every `lesson_id` and `item_id` in a behaviour
 *      event is validated against the uuid pattern at ingest, and these are the
 *      ids the seed migration will carry. Content moving into Postgres must not
 *      orphan events already collected against it.
 *   2. **Field names mirror the SQL.** `content_version`, `difficulty_weight`,
 *      `skill_weights`, `max_attempts` and `hint_texts` are the columns from
 *      PRO-3, in camelCase. Replacing this module with a query is then a change
 *      of loader, not a rewrite of every screen.
 *
 * This is authored teaching material, not placeholder data. Nothing here stands
 * in for a number the product has not measured.
 */

/** `app.exercise_item.item_type`. */
export type ItemType = "mcq" | "numeric" | "short_text" | "long_text" | "ordering";

/** Skill codes from the PRO-3 skill map. Weights for one item sum to 1. */
export type SkillWeights = Readonly<Record<string, number>>;

interface ItemBase {
  readonly id: string;
  readonly type: ItemType;
  readonly prompt: string;
  /** 1–3, as in `app.exercise_item.difficulty`. */
  readonly difficulty: 1 | 2 | 3;
  /** 0.8 / 1.0 / 1.25, paired with `difficulty` by PRO-3. */
  readonly difficultyWeight: number;
  readonly maxAttempts: number;
  /** Shown one at a time, cheapest help first. */
  readonly hintTexts: readonly string[];
  readonly skillWeights: SkillWeights;
  readonly contentVersion: number;
}

export interface McqItem extends ItemBase {
  readonly type: "mcq";
  readonly choices: readonly { readonly id: string; readonly label: string }[];
  readonly correctChoiceId: string;
  /** Why the right answer is right. Shown after the child answers, never before. */
  readonly explanation: string;
}

export interface NumericItem extends ItemBase {
  readonly type: "numeric";
  readonly correctValue: number;
  /** Absolute tolerance. A child typing 2.5 for 2.50 is not wrong. */
  readonly tolerance: number;
  readonly unit: string;
  readonly explanation: string;
}

export interface OrderingItem extends ItemBase {
  readonly type: "ordering";
  readonly options: readonly { readonly id: string; readonly label: string }[];
  /** Option ids in the reference order. */
  readonly correctOrder: readonly string[];
  readonly explanation: string;
}

/**
 * Items whose answer is prose. There is no correct answer here to compare
 * against — they exist to be graded by the AI engine (PRO-8) against a rubric,
 * which is the whole reason the product chose inquiry science.
 */
export interface WrittenItem extends ItemBase {
  readonly type: "short_text" | "long_text";
  /** `app.rubric.code`. The rubric itself is owned by AIEngineer. */
  readonly rubricCode: string;
  /** Plain-language version of the rubric, so the child knows what is wanted. */
  readonly successCriteria: readonly string[];
  readonly minChars: number;
}

export type ExerciseItem = McqItem | NumericItem | OrderingItem | WrittenItem;

/** Deterministically gradeable here and now; everything else waits for PRO-8. */
export type ClosedItem = McqItem | NumericItem | OrderingItem;

export function isWrittenItem(item: ExerciseItem): item is WrittenItem {
  return item.type === "short_text" || item.type === "long_text";
}

export interface LessonSection {
  /** Stable across content edits — `lesson.section_dwell` is keyed on it. */
  readonly id: string;
  readonly heading: string;
  readonly paragraphs: readonly string[];
  /** Optional aside rendered as a highlighted card, e.g. a common misconception. */
  readonly note?: { readonly label: string; readonly text: string };
}

export interface Lesson {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  /** One sentence a ten-year-old can use to decide whether to open it. */
  readonly summary: string;
  readonly orderIndex: number;
  readonly contentVersion: number;
  readonly estMinutes: number;
  readonly skillTags: readonly string[];
  readonly sections: readonly LessonSection[];
  /** `app.exercise_item` rows grouped as one set. */
  readonly exerciseSetId: string;
  readonly items: readonly ExerciseItem[];
}

export interface Course {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly subject: string;
  readonly gradeBand: string;
  readonly lessons: readonly Lesson[];
}
