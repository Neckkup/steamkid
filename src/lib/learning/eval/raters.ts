/**
 * The second human rater, and the arithmetic that turns two rater sheets into
 * comparable pairs.
 *
 * Why this file exists: the agreement number PRO-8 first reported (κ = 0.843)
 * compared the grader against *one* human — me — who had also written the
 * rubric and every answer in the set. That measures whether the model reproduces
 * one person's judgement. It does not measure whether the rubric is teachable,
 * and it silently assumes the ceiling for AI–human agreement is 1.0.
 *
 * It is not. Two competent humans applying the same rubric to the same writing
 * disagree, and the rate at which they disagree is the real ceiling: a grader
 * that matches a teacher as often as another teacher would has stopped being the
 * limiting factor. PRO-78 produced that second sheet — QA graded all 60 cases
 * from the answer text, the task prompt and the rubric alone, with the reference
 * levels and my per-case notes stripped by an extractor before they saw the set.
 *
 * Their grades are committed here rather than left as a ticket attachment for
 * one reason: the ceiling is now a number the release decision rests on, and a
 * number that lives in a comment thread cannot be recomputed when the rubric
 * changes. Anyone revising a level descriptor can re-run the comparison and see
 * what it did to human–human agreement, which is the first thing a rubric change
 * should be judged on.
 */

import { EVAL_CASES, type EvalCase } from "@/lib/learning/eval/cases";
import type { LevelPair } from "@/lib/learning/eval/agreement";
import type { RubricLevel, WrittenSkillCode } from "@/lib/learning/rubric";

/**
 * A rater may decline a cell. That is a judgement, not a missing value: QA
 * marked two answers as "ตรวจไม่ได้" — not gradeable from what the child wrote.
 * Collapsing that to 0 would invent agreement with a grader that returned 0, and
 * dropping it silently would hide that a human also refused.
 */
export type RaterLevel = RubricLevel | "unscorable";

/** `caseId → skillCode → level`. Sparse: a rater covers an item's skills only. */
export type RaterGrades = Readonly<
  Record<string, Readonly<Partial<Record<WrittenSkillCode, RaterLevel>>>>
>;

/**
 * QA's independent grading of `written-grading-v1`, from [PRO-78].
 *
 * Blinding, as QA described it on the ticket: graded from answer text, item
 * prompt and rubric only; `reference` levels and `note` fields were masked by an
 * extractor script rather than by willpower. The two `"unscorable"` cells are
 * theirs, not a transcription gap.
 */
export const QA_INDEPENDENT_GRADES: RaterGrades = {
  "box-01": { "SCI.EXPLAIN_EVIDENCE": 2, "COMM.SCI_WRITING": 1 },
  "box-02": { "SCI.EXPLAIN_EVIDENCE": 1, "COMM.SCI_WRITING": 2 },
  "box-03": { "SCI.EXPLAIN_EVIDENCE": 2, "COMM.SCI_WRITING": 2 },
  "box-04": { "SCI.EXPLAIN_EVIDENCE": 3, "COMM.SCI_WRITING": 3 },
  "box-05": { "SCI.EXPLAIN_EVIDENCE": 3, "COMM.SCI_WRITING": 3 },
  "box-06": { "SCI.EXPLAIN_EVIDENCE": 1, "COMM.SCI_WRITING": 2 },
  "box-07": { "SCI.EXPLAIN_EVIDENCE": 3, "COMM.SCI_WRITING": 3 },
  "box-08": { "SCI.EXPLAIN_EVIDENCE": 1, "COMM.SCI_WRITING": 1 },
  "box-09": { "SCI.EXPLAIN_EVIDENCE": 0, "COMM.SCI_WRITING": 2 },
  "box-10": { "SCI.EXPLAIN_EVIDENCE": 3, "COMM.SCI_WRITING": 2 },
  "story-01": { "COMM.SCI_WRITING": 1, "SCI.CONCEPT_FORCE_MOTION": 2 },
  "story-02": { "COMM.SCI_WRITING": 3, "SCI.CONCEPT_FORCE_MOTION": 3 },
  "story-03": { "COMM.SCI_WRITING": 2, "SCI.CONCEPT_FORCE_MOTION": 2 },
  "story-04": { "COMM.SCI_WRITING": 3, "SCI.CONCEPT_FORCE_MOTION": 3 },
  "story-05": { "COMM.SCI_WRITING": 2, "SCI.CONCEPT_FORCE_MOTION": 1 },
  "story-06": { "COMM.SCI_WRITING": 1, "SCI.CONCEPT_FORCE_MOTION": 2 },
  "story-07": { "COMM.SCI_WRITING": 3, "SCI.CONCEPT_FORCE_MOTION": 3 },
  "story-08": { "COMM.SCI_WRITING": 2, "SCI.CONCEPT_FORCE_MOTION": 1 },
  "story-09": { "COMM.SCI_WRITING": "unscorable", "SCI.CONCEPT_FORCE_MOTION": "unscorable" },
  "story-10": { "COMM.SCI_WRITING": 2, "SCI.CONCEPT_FORCE_MOTION": 3 },
  "friction-01": { "SCI.EXPLAIN_EVIDENCE": 1, "COMM.SCI_WRITING": 1 },
  "friction-02": { "SCI.EXPLAIN_EVIDENCE": 3, "COMM.SCI_WRITING": 3 },
  "friction-03": { "SCI.EXPLAIN_EVIDENCE": 2, "COMM.SCI_WRITING": 2 },
  "friction-04": { "SCI.EXPLAIN_EVIDENCE": 3, "COMM.SCI_WRITING": 3 },
  "friction-05": { "SCI.EXPLAIN_EVIDENCE": 1, "COMM.SCI_WRITING": 1 },
  "friction-06": { "SCI.EXPLAIN_EVIDENCE": 3, "COMM.SCI_WRITING": 3 },
  "friction-07": { "SCI.EXPLAIN_EVIDENCE": 1, "COMM.SCI_WRITING": 2 },
  "friction-08": { "SCI.EXPLAIN_EVIDENCE": 2, "COMM.SCI_WRITING": 3 },
  "friction-09": { "SCI.EXPLAIN_EVIDENCE": 0, "COMM.SCI_WRITING": 2 },
  "friction-10": { "SCI.EXPLAIN_EVIDENCE": 3, "COMM.SCI_WRITING": 3 },
  "design-01": { "SCI.HYPOTHESIS": 1, "CT.DECOMPOSE_SEQUENCE": 1, "COMM.SCI_WRITING": 1 },
  "design-02": { "SCI.HYPOTHESIS": 3, "CT.DECOMPOSE_SEQUENCE": 3, "COMM.SCI_WRITING": 3 },
  "design-03": { "SCI.HYPOTHESIS": 1, "CT.DECOMPOSE_SEQUENCE": 2, "COMM.SCI_WRITING": 2 },
  "design-04": { "SCI.HYPOTHESIS": 2, "CT.DECOMPOSE_SEQUENCE": 1, "COMM.SCI_WRITING": 2 },
  "design-05": { "SCI.HYPOTHESIS": 1, "CT.DECOMPOSE_SEQUENCE": 3, "COMM.SCI_WRITING": 3 },
  "design-06": { "SCI.HYPOTHESIS": 1, "CT.DECOMPOSE_SEQUENCE": 2, "COMM.SCI_WRITING": 2 },
  "design-07": { "SCI.HYPOTHESIS": 3, "CT.DECOMPOSE_SEQUENCE": 0, "COMM.SCI_WRITING": 2 },
  "design-08": { "SCI.HYPOTHESIS": 1, "CT.DECOMPOSE_SEQUENCE": 0, "COMM.SCI_WRITING": 1 },
  "design-09": { "SCI.HYPOTHESIS": 2, "CT.DECOMPOSE_SEQUENCE": 3, "COMM.SCI_WRITING": 3 },
  "design-10": { "SCI.HYPOTHESIS": 1, "CT.DECOMPOSE_SEQUENCE": 1, "COMM.SCI_WRITING": 1 },
  "predict-01": { "SCI.HYPOTHESIS": 2, "COMM.SCI_WRITING": 2 },
  "predict-02": { "SCI.HYPOTHESIS": 3, "COMM.SCI_WRITING": 3 },
  "predict-03": { "SCI.HYPOTHESIS": 0, "COMM.SCI_WRITING": 1 },
  "predict-04": { "SCI.HYPOTHESIS": 1, "COMM.SCI_WRITING": 2 },
  "predict-05": { "SCI.HYPOTHESIS": 2, "COMM.SCI_WRITING": 3 },
  "predict-06": { "SCI.HYPOTHESIS": 2, "COMM.SCI_WRITING": 2 },
  "predict-07": { "SCI.HYPOTHESIS": 0, "COMM.SCI_WRITING": 1 },
  "predict-08": { "SCI.HYPOTHESIS": 3, "COMM.SCI_WRITING": 3 },
  "predict-09": { "SCI.HYPOTHESIS": 0, "COMM.SCI_WRITING": 2 },
  "predict-10": { "SCI.HYPOTHESIS": 2, "COMM.SCI_WRITING": 3 },
  "heavy-01": { "SCI.EXPLAIN_EVIDENCE": 1, "COMM.SCI_WRITING": 1, "SCI.CONCEPT_FORCE_MOTION": 2 },
  "heavy-02": { "SCI.EXPLAIN_EVIDENCE": 3, "COMM.SCI_WRITING": 3, "SCI.CONCEPT_FORCE_MOTION": 3 },
  "heavy-03": { "SCI.EXPLAIN_EVIDENCE": 2, "COMM.SCI_WRITING": 2, "SCI.CONCEPT_FORCE_MOTION": 2 },
  "heavy-04": { "SCI.EXPLAIN_EVIDENCE": 2, "COMM.SCI_WRITING": 2, "SCI.CONCEPT_FORCE_MOTION": 1 },
  "heavy-05": { "SCI.EXPLAIN_EVIDENCE": 1, "COMM.SCI_WRITING": 2, "SCI.CONCEPT_FORCE_MOTION": 2 },
  "heavy-06": { "SCI.EXPLAIN_EVIDENCE": 2, "COMM.SCI_WRITING": 3, "SCI.CONCEPT_FORCE_MOTION": 3 },
  "heavy-07": { "SCI.EXPLAIN_EVIDENCE": 1, "COMM.SCI_WRITING": 2, "SCI.CONCEPT_FORCE_MOTION": 2 },
  "heavy-08": { "SCI.EXPLAIN_EVIDENCE": 3, "COMM.SCI_WRITING": 3, "SCI.CONCEPT_FORCE_MOTION": 2 },
  "heavy-09": { "SCI.EXPLAIN_EVIDENCE": 0, "COMM.SCI_WRITING": 1, "SCI.CONCEPT_FORCE_MOTION": 0 },
  "heavy-10": { "SCI.EXPLAIN_EVIDENCE": 1, "COMM.SCI_WRITING": 1, "SCI.CONCEPT_FORCE_MOTION": 2 },};

/** My reference levels from `cases.ts`, in the same shape, as rater "author". */
export function authorGrades(cases: readonly EvalCase[] = EVAL_CASES): RaterGrades {
  return Object.fromEntries(cases.map((c) => [c.id, c.reference]));
}

/** One cell where the two raters parted company, for the disagreement table. */
export interface RaterDisagreement {
  readonly caseId: string;
  readonly skillCode: WrittenSkillCode;
  readonly a: RaterLevel;
  readonly b: RaterLevel;
}

export interface RaterComparison {
  /** Cells both raters put a number on — the only ones kappa can use. */
  readonly pairs: readonly LevelPair[];
  /**
   * Cells exactly one rater declined. Reported, never imputed: these are the
   * cases where one grader saw something to judge and the other did not, which
   * is a rubric problem worth naming rather than a rounding error.
   */
  readonly declinedByOne: readonly RaterDisagreement[];
  /** Cells both declined — agreement, but not the kind kappa can score. */
  readonly declinedByBoth: number;
  /** Cells one rater covered and the other never rated at all. */
  readonly unmatched: number;
  /** Numeric cells at least two levels apart — where the rubric actually bites. */
  readonly severe: readonly RaterDisagreement[];
}

/**
 * Pair two rater sheets cell by cell.
 *
 * `LevelPair` calls its sides `reference` and `predicted` because it was written
 * for human-versus-model. Here `a` fills `reference` and `b` fills `predicted`,
 * so a positive `meanSignedError` reads as "**b** grades more generously than
 * **a**". Quadratic weighted kappa itself is symmetric, so the assignment only
 * affects the direction of the bias number, never the headline.
 */
export function compareRaters(a: RaterGrades, b: RaterGrades): RaterComparison {
  const pairs: LevelPair[] = [];
  const declinedByOne: RaterDisagreement[] = [];
  const severe: RaterDisagreement[] = [];
  let declinedByBoth = 0;
  let unmatched = 0;

  for (const [caseId, aCells] of Object.entries(a)) {
    const bCells = b[caseId];
    for (const [skill, aLevel] of Object.entries(aCells) as [
      WrittenSkillCode,
      RaterLevel,
    ][]) {
      const bLevel = bCells?.[skill];
      if (bLevel === undefined) {
        unmatched += 1;
        continue;
      }
      const aDeclined = aLevel === "unscorable";
      const bDeclined = bLevel === "unscorable";
      if (aDeclined && bDeclined) {
        declinedByBoth += 1;
        continue;
      }
      if (aDeclined || bDeclined) {
        declinedByOne.push({ caseId, skillCode: skill, a: aLevel, b: bLevel });
        continue;
      }
      pairs.push({ skillCode: skill, reference: aLevel, predicted: bLevel });
      if (Math.abs(bLevel - aLevel) >= 2) {
        severe.push({ caseId, skillCode: skill, a: aLevel, b: bLevel });
      }
    }
  }

  // Cells rater b covered that a never rated: counted from the other direction
  // so `unmatched` means "not comparable", not "missing from b".
  for (const [caseId, bCells] of Object.entries(b)) {
    const aCells = a[caseId];
    for (const skill of Object.keys(bCells) as WrittenSkillCode[]) {
      if (aCells?.[skill] === undefined) unmatched += 1;
    }
  }

  return { pairs, declinedByOne, declinedByBoth, unmatched, severe };
}
