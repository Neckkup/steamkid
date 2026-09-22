/**
 * Where a child is in an exercise set, as plain data.
 *
 * `PracticeRunner` counts `index` one past the last item to mean "done", and
 * every hook in that component reads the current item during render — before
 * the summary's early return can happen. `items[index]!` was therefore
 * `undefined` on exactly the render that should have shown the summary, and
 * the whole lesson ended in an error boundary instead (PRO-41).
 *
 * The runner is a client component full of effects and fetches, so the part
 * that broke lives here instead, where a test can walk a set to the end.
 */

export type ItemOutcome =
  | {
      readonly kind: "graded";
      readonly result: "correct" | "partial" | "incorrect";
      readonly explanation: string;
      readonly attemptsLeft: number;
    }
  | { readonly kind: "pending_ai"; readonly pendingReason: string }
  | { readonly kind: "skipped" };

/** True once the child has stepped past the last item. */
export function isFinished(itemCount: number, index: number): boolean {
  return index >= itemCount;
}

/**
 * The item the screen is working with — never `undefined`, for any index.
 *
 * Past the end it holds the item the child just finished. Nothing displays it
 * there: the summary branch renders no question and no input, and the
 * abandon-tracking cleanup returns early once `isFinished`. It exists so the
 * hooks that name `item.id` in a dependency array have something to name.
 */
export function itemAt<T>(items: readonly T[], index: number): T | undefined {
  if (items.length === 0) return undefined;
  return items[Math.min(Math.max(index, 0), items.length - 1)];
}

export interface PracticeSummary {
  readonly correct: number;
  readonly partial: number;
  /** Graded incorrect. Named "not yet" everywhere a child can read it. */
  readonly notYet: number;
  readonly waiting: number;
  readonly skipped: number;
}

/**
 * What the end-of-set card counts. Anything not graded correct is not "ถูก".
 *
 * Every outcome lands in exactly one bucket, which is the point: the card used
 * to have no line for a wrong answer, so a child who got three of five wrong
 * read "ตอบถูก: 2 ข้อ" and the other three simply were not mentioned. Nobody
 * had seen it, because the card itself was unreachable (PRO-41).
 */
export function summarise(outcomes: Readonly<Record<string, ItemOutcome>>): PracticeSummary {
  const values = Object.values(outcomes);
  const graded = (result: "correct" | "partial" | "incorrect") =>
    values.filter((value) => value.kind === "graded" && value.result === result).length;

  return {
    correct: graded("correct"),
    partial: graded("partial"),
    notYet: graded("incorrect"),
    waiting: values.filter((value) => value.kind === "pending_ai").length,
    skipped: values.filter((value) => value.kind === "skipped").length,
  };
}
