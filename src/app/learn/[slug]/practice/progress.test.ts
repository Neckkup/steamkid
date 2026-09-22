/**
 * PRO-41: a child who answered every question was shown an error boundary
 * instead of the summary, because `items[index]` is `undefined` on the one
 * render where `index === items.length`.
 *
 * QA asked for a test that walks a set to the end — nothing in the repo ever
 * pushed `index` past the last item. That walk is the first test here, and it
 * asserts on the step the runner performs before any early return: read the
 * current item, then decide whether the set is finished.
 */

import { describe, expect, it } from "vitest";

import { isFinished, itemAt, summarise, type ItemOutcome } from "./progress";

const FIVE = ["q1", "q2", "q3", "q4", "q5"] as const;

const graded = (result: "correct" | "partial" | "incorrect"): ItemOutcome => ({
  kind: "graded",
  result,
  explanation: "",
  attemptsLeft: 0,
});

describe("walking an exercise set to the end", () => {
  it("has an item to read at every index, including one past the last", () => {
    // The loop goes to items.length inclusive: that final step is the one that
    // used to throw "Cannot read properties of undefined (reading 'id')".
    for (let index = 0; index <= FIVE.length; index += 1) {
      expect(itemAt(FIVE, index), `index ${index}`).toBeDefined();
    }
  });

  it("reports finished only after the last item, not on it", () => {
    expect(isFinished(FIVE.length, FIVE.length - 1)).toBe(false);
    expect(isFinished(FIVE.length, FIVE.length)).toBe(true);
  });

  it("shows the real item while the child is still answering", () => {
    expect(FIVE.map((_, index) => itemAt(FIVE, index))).toEqual([...FIVE]);
  });

  it("holds the last item past the end rather than dropping to undefined", () => {
    expect(itemAt(FIVE, FIVE.length)).toBe("q5");
    expect(itemAt(FIVE, FIVE.length + 10)).toBe("q5");
  });

  it("survives a one-item set, where the first step is also the last", () => {
    expect(itemAt(["only"], 0)).toBe("only");
    expect(itemAt(["only"], 1)).toBe("only");
    expect(isFinished(1, 1)).toBe(true);
  });

  it("has nothing to show for an empty set, which the page catches first", () => {
    expect(itemAt([], 0)).toBeUndefined();
    expect(isFinished(0, 0)).toBe(true);
  });
});

describe("summarise", () => {
  it("counts an empty run as zero of everything, not as a blank card", () => {
    expect(summarise({})).toEqual({ correct: 0, partial: 0, notYet: 0, waiting: 0, skipped: 0 });
  });

  it("counts each outcome under its own heading", () => {
    const summary = summarise({
      q1: graded("correct"),
      q2: graded("partial"),
      q3: graded("incorrect"),
      q4: { kind: "pending_ai", pendingReason: "grader_not_available" },
      q5: { kind: "skipped" },
    });

    expect(summary).toEqual({ correct: 1, partial: 1, notYet: 1, waiting: 1, skipped: 1 });
  });

  it("never counts an incorrect answer as correct", () => {
    const summary = summarise({ q1: graded("incorrect"), q2: graded("incorrect") });

    expect(summary.correct).toBe(0);
    expect(summary.notYet).toBe(2);
  });

  it("accounts for every item the child worked on, so the card adds up", () => {
    // The card used to have no line for a wrong answer: five questions, three
    // wrong, and only two of them mentioned anywhere.
    const outcomes: Record<string, ItemOutcome> = {
      q1: graded("correct"),
      q2: graded("incorrect"),
      q3: graded("incorrect"),
      q4: graded("incorrect"),
      q5: { kind: "skipped" },
    };
    const summary = summarise(outcomes);
    const shown =
      summary.correct + summary.partial + summary.notYet + summary.waiting + summary.skipped;

    expect(shown).toBe(Object.keys(outcomes).length);
  });
});
