import { describe, expect, it } from "vitest";

import { EVAL_CASES } from "@/lib/learning/eval/cases";
import {
  authorGrades,
  compareRaters,
  QA_INDEPENDENT_GRADES,
} from "@/lib/learning/eval/raters";
import { quadraticWeightedKappa } from "@/lib/learning/eval/agreement";
import type { WrittenSkillCode } from "@/lib/learning/rubric";

/**
 * These guard the ceiling number, not the library. κ(author, QA) is what the
 * release decision compares the grader against, so the ways it could be quietly
 * overstated are worth pinning: a declined cell counted as a match, a cell
 * dropped instead of reported, or the two sheets drifting out of alignment.
 */
describe("compareRaters", () => {
  const a = {
    "case-1": { "SCI.EXPLAIN_EVIDENCE": 2, "COMM.SCI_WRITING": 1 },
    "case-2": { "SCI.EXPLAIN_EVIDENCE": 0 },
  } as const;

  it("pairs only cells both raters put a number on", () => {
    const result = compareRaters(a, {
      "case-1": { "SCI.EXPLAIN_EVIDENCE": 3, "COMM.SCI_WRITING": 1 },
      "case-2": { "SCI.EXPLAIN_EVIDENCE": 0 },
    });

    expect(result.pairs).toHaveLength(3);
    expect(result.declinedByOne).toHaveLength(0);
    expect(result.unmatched).toBe(0);
  });

  it("never lets a declined cell count as agreement", () => {
    const result = compareRaters(a, {
      "case-1": { "SCI.EXPLAIN_EVIDENCE": "unscorable", "COMM.SCI_WRITING": 1 },
      "case-2": { "SCI.EXPLAIN_EVIDENCE": "unscorable" },
    });

    // Two declined cells: neither becomes a pair, and neither becomes a 0.
    expect(result.pairs).toHaveLength(1);
    expect(result.declinedByOne).toHaveLength(2);
    expect(result.pairs[0]).toEqual({
      skillCode: "COMM.SCI_WRITING",
      reference: 1,
      predicted: 1,
    });
  });

  it("counts a cell as agreement when both raters declined it", () => {
    const result = compareRaters(
      { "case-1": { "SCI.EXPLAIN_EVIDENCE": "unscorable" } },
      { "case-1": { "SCI.EXPLAIN_EVIDENCE": "unscorable" } },
    );

    expect(result.declinedByBoth).toBe(1);
    expect(result.declinedByOne).toHaveLength(0);
    expect(result.pairs).toHaveLength(0);
  });

  it("reports cells only one rater covered instead of dropping them", () => {
    const result = compareRaters(a, { "case-1": { "SCI.EXPLAIN_EVIDENCE": 2 } });

    expect(result.pairs).toHaveLength(1);
    expect(result.unmatched).toBe(2); // case-1 COMM.SCI_WRITING, case-2 entirely
  });

  it("flags disagreements of two or more levels", () => {
    const result = compareRaters(a, {
      "case-1": { "SCI.EXPLAIN_EVIDENCE": 0, "COMM.SCI_WRITING": 2 },
      "case-2": { "SCI.EXPLAIN_EVIDENCE": 0 },
    });

    expect(result.severe).toEqual([
      { caseId: "case-1", skillCode: "SCI.EXPLAIN_EVIDENCE", a: 2, b: 0 },
    ]);
  });

  it("is symmetric in kappa and antisymmetric in bias", () => {
    const b = {
      "case-1": { "SCI.EXPLAIN_EVIDENCE": 3, "COMM.SCI_WRITING": 0 },
      "case-2": { "SCI.EXPLAIN_EVIDENCE": 1 },
    } as const;

    expect(quadraticWeightedKappa(compareRaters(a, b).pairs)).toBeCloseTo(
      quadraticWeightedKappa(compareRaters(b, a).pairs),
      10,
    );
  });
});

describe("QA_INDEPENDENT_GRADES", () => {
  it("covers every eval case on exactly the criteria the case is graded on", () => {
    // If the two sheets ever drift apart, `compareRaters` would silently shrink
    // the comparison rather than fail, and the ceiling would be computed over a
    // different set of criteria than the grader was asked for.
    for (const evalCase of EVAL_CASES) {
      const qaCells = QA_INDEPENDENT_GRADES[evalCase.id];
      expect(qaCells, `QA did not grade ${evalCase.id}`).toBeDefined();
      expect(Object.keys(qaCells!).sort()).toEqual(
        Object.keys(evalCase.reference).sort(),
      );
    }
  });

  it("aligns fully with the author sheet, leaving no unmatched cells", () => {
    const result = compareRaters(authorGrades(), QA_INDEPENDENT_GRADES);

    expect(result.unmatched).toBe(0);
    expect(result.pairs.length + result.declinedByOne.length + result.declinedByBoth).toBe(
      EVAL_CASES.reduce((n, c) => n + Object.keys(c.reference).length, 0),
    );
  });

  it("uses only levels the rubric defines", () => {
    for (const [caseId, cells] of Object.entries(QA_INDEPENDENT_GRADES)) {
      for (const [skill, level] of Object.entries(cells) as [
        WrittenSkillCode,
        number | "unscorable",
      ][]) {
        if (level === "unscorable") continue;
        expect(
          [0, 1, 2, 3],
          `${caseId}/${skill} is ${level}`,
        ).toContain(level);
      }
    }
  });
});
