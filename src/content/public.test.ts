/**
 * PRO-40: the lesson card promised six questions and the runner asked five.
 *
 * The card now reads its number from `lessonWorkload`, which shares its
 * predicate with `practiceItems` — the array the runner counts "ข้อ 1 จาก N"
 * against. These tests pin the two together so the numbers cannot drift again.
 */

import { describe, expect, it } from "vitest";

import { FORCE_AND_MOTION } from "./force-and-motion";
import { lessonWorkload, practiceItems, projectItem } from "./public";

describe("lessonWorkload", () => {
  it("counts exactly what the practice runner will ask", () => {
    for (const lesson of FORCE_AND_MOTION.lessons) {
      expect(lessonWorkload(lesson).questionCount).toBe(practiceItems(lesson).length);
    }
  });

  it("counts the project separately from the questions", () => {
    for (const lesson of FORCE_AND_MOTION.lessons) {
      const { questionCount, projectCount } = lessonWorkload(lesson);
      expect(projectCount).toBe(projectItem(lesson) ? 1 : 0);
      expect(questionCount + projectCount).toBe(lesson.items.length);
    }
  });

  it("never counts a project as a question", () => {
    const lesson = FORCE_AND_MOTION.lessons.find((candidate) =>
      candidate.items.some((item) => item.type === "long_text"),
    );
    expect(lesson).toBeDefined();
    expect(lessonWorkload(lesson!).questionCount).toBeLessThan(lesson!.items.length);
  });
});
