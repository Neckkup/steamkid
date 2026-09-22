/**
 * Agreement between the AI grader and the human reference levels.
 *
 * The headline number is **quadratic weighted Cohen's kappa**, and the choice
 * matters more than it looks:
 *
 * - Raw percent agreement is misleading here. Rubric levels are not uniformly
 *   distributed — most real answers land on 2 — so a grader that returned "2"
 *   for everything would post a respectable-looking exact-match rate while
 *   measuring nothing. Kappa subtracts the agreement you would get by chance
 *   from the observed marginals, so that grader scores ~0.
 *
 * - *Quadratic* weighting because the levels are ordinal. Calling a level-3
 *   answer a 2 is a small error; calling it a 0 is a serious one, and an
 *   unweighted kappa treats those as the same mistake. Squared distance is the
 *   convention for ordered rubric scales and is what education research reports,
 *   which means our number can be compared to a published one.
 *
 * Kappa alone is still not enough to act on, so everything below it exists to
 * answer "where is it wrong": per-skill kappa finds the criterion the model
 * cannot judge, and the signed mean error says whether it is generous or harsh.
 * Those two decide what the next prompt revision changes; kappa only says
 * whether the change helped.
 *
 * Nothing here is a monitoring or evaluation *system* — Langfuse Datasets holds
 * the set, the runs and the scores. This is the arithmetic that turns one run's
 * rows into the numbers PRO-8 has to report, which Langfuse cannot compute for
 * us because the reference labels are ours.
 */

import type { RubricLevel, WrittenSkillCode } from "@/lib/learning/rubric";

/** One criterion, graded twice: once by a human, once by the model. */
export interface LevelPair {
  readonly skillCode: WrittenSkillCode;
  readonly reference: RubricLevel;
  readonly predicted: RubricLevel;
}

const LEVEL_COUNT = 4; // levels 0–3

export interface AgreementStats {
  readonly n: number;
  /** Quadratic weighted Cohen's kappa. 1 = perfect, 0 = chance, <0 = worse than chance. */
  readonly quadraticKappa: number;
  /** Share of criteria where the levels matched exactly. */
  readonly exact: number;
  /** Share within one level. The band a teacher would call "close enough". */
  readonly within1: number;
  /**
   * Mean of (predicted − reference). Positive means the AI grades **easier**
   * than the human, which on a children's product is the more dangerous
   * direction: it tells a child they have understood something they have not,
   * and the learning path then moves them on.
   */
  readonly meanSignedError: number;
  readonly meanAbsoluteError: number;
}

/**
 * Quadratic weighted kappa.
 *
 * Returns 1 when both graders used a single identical level for everything:
 * the expected-disagreement denominator is 0 there, and while the statistic is
 * formally undefined, the two graders did agree on every item. Reporting 0 for
 * that case would say "chance-level", which is the opposite of what happened.
 */
export function quadraticWeightedKappa(pairs: readonly LevelPair[]): number {
  if (pairs.length === 0) return Number.NaN;

  const observed: number[][] = Array.from({ length: LEVEL_COUNT }, () =>
    Array.from({ length: LEVEL_COUNT }, () => 0),
  );
  const refMarginal = Array.from({ length: LEVEL_COUNT }, () => 0);
  const predMarginal = Array.from({ length: LEVEL_COUNT }, () => 0);

  for (const { reference, predicted } of pairs) {
    observed[reference][predicted] += 1;
    refMarginal[reference] += 1;
    predMarginal[predicted] += 1;
  }

  const n = pairs.length;
  const maxDistanceSquared = (LEVEL_COUNT - 1) ** 2;

  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < LEVEL_COUNT; i += 1) {
    for (let j = 0; j < LEVEL_COUNT; j += 1) {
      const weight = (i - j) ** 2 / maxDistanceSquared;
      const expected = (refMarginal[i] * predMarginal[j]) / n;
      numerator += weight * observed[i][j];
      denominator += weight * expected;
    }
  }

  if (denominator === 0) return numerator === 0 ? 1 : 0;
  return 1 - numerator / denominator;
}

export function agreementStats(pairs: readonly LevelPair[]): AgreementStats {
  const n = pairs.length;
  if (n === 0) {
    return {
      n: 0,
      quadraticKappa: Number.NaN,
      exact: Number.NaN,
      within1: Number.NaN,
      meanSignedError: Number.NaN,
      meanAbsoluteError: Number.NaN,
    };
  }

  let exact = 0;
  let within1 = 0;
  let signed = 0;
  let absolute = 0;

  for (const { reference, predicted } of pairs) {
    const delta = predicted - reference;
    if (delta === 0) exact += 1;
    if (Math.abs(delta) <= 1) within1 += 1;
    signed += delta;
    absolute += Math.abs(delta);
  }

  return {
    n,
    quadraticKappa: quadraticWeightedKappa(pairs),
    exact: exact / n,
    within1: within1 / n,
    meanSignedError: signed / n,
    meanAbsoluteError: absolute / n,
  };
}

/** Per-skill breakdown — the view that says *what* to fix in the next revision. */
export function agreementBySkill(
  pairs: readonly LevelPair[],
): Record<string, AgreementStats> {
  const groups = new Map<string, LevelPair[]>();
  for (const pair of pairs) {
    const bucket = groups.get(pair.skillCode);
    if (bucket) bucket.push(pair);
    else groups.set(pair.skillCode, [pair]);
  }

  return Object.fromEntries(
    [...groups.entries()]
      .map(([skill, group]) => [skill, agreementStats(group)] as const)
      .sort((a, b) => a[1].quadraticKappa - b[1].quadraticKappa),
  );
}

/**
 * The confusion matrix, as rows a human reads without a chart.
 *
 * Worth printing even when kappa looks fine: a grader that never uses level 0
 * has a systematic blind spot that the summary statistics average away, and the
 * matrix is where that shows up as an empty column.
 */
export function confusionMatrix(pairs: readonly LevelPair[]): number[][] {
  const matrix: number[][] = Array.from({ length: LEVEL_COUNT }, () =>
    Array.from({ length: LEVEL_COUNT }, () => 0),
  );
  for (const { reference, predicted } of pairs) matrix[reference][predicted] += 1;
  return matrix;
}

/** Interpretation bands, so a number in a comment carries its own verdict. */
export function kappaLabel(kappa: number): string {
  if (Number.isNaN(kappa)) return "no data";
  if (kappa >= 0.8) return "almost perfect";
  if (kappa >= 0.6) return "substantial";
  if (kappa >= 0.4) return "moderate";
  if (kappa >= 0.2) return "fair";
  return "poor";
}
