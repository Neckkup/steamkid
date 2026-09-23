/**
 * Three-way agreement: the grader, me, and a second independent human.
 *
 *   npm run eval:raters                      # against run v1-baseline
 *   npm run eval:raters -- --run-name <name> # against any recorded run
 *
 * The question this answers is the one `eval:grading` cannot. That script
 * reports how closely the model reproduces the reference levels in `cases.ts`,
 * which are mine. Read alone, its number implies the target is 1.0 — that a
 * perfect grader agrees with me on every cell. No human does. QA graded the same
 * 60 cases blind for [PRO-78], and the gap between *those two humans* is the
 * ceiling the model should actually be measured against.
 *
 * So: no new Gemini calls. The AI's levels are read back out of the recorded
 * Langfuse dataset run, where `eval:grading` wrote one `level-delta.<skill>`
 * score per criterion with the pair in its comment. Re-grading would cost money
 * and, worse, would quietly compare a *different* set of predictions against the
 * human sheets — the run being cited in the ticket would no longer be the run
 * being analysed. Langfuse is the store of record for runs; this reads from it
 * rather than keeping a second copy.
 */
import { env } from "@/lib/env";
import {
  agreementBySkill,
  agreementStats,
  confusionMatrix,
  kappaLabel,
  type AgreementStats,
} from "@/lib/learning/eval/agreement";
import { EVAL_CASES } from "@/lib/learning/eval/cases";
import {
  authorGrades,
  compareRaters,
  QA_INDEPENDENT_GRADES,
  type RaterComparison,
  type RaterGrades,
  type RaterLevel,
} from "@/lib/learning/eval/raters";
import type { RubricLevel, WrittenSkillCode } from "@/lib/learning/rubric";

const DATASET_NAME = "written-grading-v1";

const args = process.argv.slice(2);
const runNameArg = args.indexOf("--run-name");
const runName = runNameArg >= 0 ? args[runNameArg + 1] : "v1-baseline";

function api(path: string): Promise<Response> {
  if (!env.LANGFUSE_BASEURL || !env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) {
    throw new Error(
      "Langfuse is not configured. Set LANGFUSE_BASEURL (or LANGFUSE_BASE_URL), " +
        "LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY.",
    );
  }
  const auth = Buffer.from(
    `${env.LANGFUSE_PUBLIC_KEY}:${env.LANGFUSE_SECRET_KEY}`,
  ).toString("base64");
  return fetch(`${env.LANGFUSE_BASEURL.replace(/\/$/, "")}/api/public${path}`, {
    headers: { authorization: `Basic ${auth}`, "content-type": "application/json" },
  });
}

async function json<T>(path: string): Promise<T> {
  const response = await api(path);
  if (!response.ok) {
    throw new Error(`GET ${path} -> ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

interface RunItem {
  readonly traceId: string | null;
  readonly datasetItemId: string;
}

interface Score {
  readonly name: string;
  readonly comment: string | null;
  readonly traceId: string | null;
}

/**
 * Rebuild the grader's sheet from the scores on a recorded run.
 *
 * The level itself is not stored as a score value — the value is the *delta*
 * from the reference, and the absolute pair lives in the comment
 * (`ai=2 human=3`). Parsing it back is a little indirect, but it means this
 * reads exactly what the ticket cited instead of a re-derivation. A comment
 * that does not match the expected shape is a hard failure rather than a
 * skipped cell: silently dropping criteria would shrink `n` and inflate the
 * agreement figures that decision rests on.
 */
async function aiGradesFromRun(): Promise<{
  grades: RaterGrades;
  nonVerdict: Map<string, string>;
}> {
  const run = await json<{ datasetRunItems: RunItem[] }>(
    `/datasets/${encodeURIComponent(DATASET_NAME)}/runs/${encodeURIComponent(runName)}`,
  );

  const caseIdByTrace = new Map<string, string>();
  for (const item of run.datasetRunItems) {
    if (item.traceId) caseIdByTrace.set(item.traceId, item.datasetItemId);
  }

  const scores: Score[] = [];
  for (let page = 1; ; page += 1) {
    const body = await json<{ data: Score[]; meta: { totalPages: number } }>(
      `/v2/scores?limit=100&page=${page}`,
    );
    scores.push(...body.data);
    if (page >= body.meta.totalPages) break;
  }

  const grades: Record<string, Partial<Record<WrittenSkillCode, RaterLevel>>> = {};
  const nonVerdict = new Map<string, string>();

  for (const score of scores) {
    const caseId = score.traceId ? caseIdByTrace.get(score.traceId) : undefined;
    if (!caseId) continue; // a score from another run or another dataset

    if (score.name === "non-verdict") {
      nonVerdict.set(caseId, score.comment ?? "unknown");
      continue;
    }
    if (!score.name.startsWith("level-delta.")) continue;

    const skillCode = score.name.slice("level-delta.".length) as WrittenSkillCode;
    const matched = /^ai=(\d) human=(\d)$/.exec(score.comment ?? "");
    if (!matched) {
      throw new Error(
        `Score "${score.name}" on case ${caseId} has comment ${JSON.stringify(
          score.comment,
        )}, which does not carry the level pair. Cannot rebuild the run's levels.`,
      );
    }
    (grades[caseId] ??= {})[skillCode] = Number(matched[1]) as RubricLevel;
  }

  // Every case the run refused is still a cell on the sheet — recorded as a
  // declined judgement, exactly like a human's "ตรวจไม่ได้", so that a refusal
  // never quietly reads as agreement or as a zero.
  for (const evalCase of EVAL_CASES) {
    if (!nonVerdict.has(evalCase.id)) continue;
    const cells: Partial<Record<WrittenSkillCode, RaterLevel>> = {};
    for (const skill of Object.keys(evalCase.reference) as WrittenSkillCode[]) {
      cells[skill] = "unscorable";
    }
    grades[evalCase.id] = cells;
  }

  return { grades, nonVerdict };
}

function pct(value: number): string {
  return Number.isNaN(value) ? "   — " : `${(value * 100).toFixed(1)}%`;
}

function signed(value: number): string {
  return Number.isNaN(value) ? "  —  " : `${value >= 0 ? "+" : ""}${value.toFixed(3)}`;
}

function summaryRow(label: string, stats: AgreementStats): string {
  return (
    `${label.padEnd(26)} ${String(stats.n).padStart(4)}  ` +
    `${stats.quadraticKappa.toFixed(3).padStart(6)}  ` +
    `${pct(stats.exact).padStart(6)}  ${pct(stats.within1).padStart(6)}  ` +
    `${signed(stats.meanSignedError).padStart(7)}`
  );
}

function describe(label: string, comparison: RaterComparison): void {
  const stats = agreementStats(comparison.pairs);
  console.log(`\n${"─".repeat(72)}`);
  console.log(`${label}   κ=${stats.quadraticKappa.toFixed(3)} (${kappaLabel(stats.quadraticKappa)})`);
  console.log(
    `  comparable cells ${stats.n}   ` +
      `declined by one ${comparison.declinedByOne.length}   ` +
      `declined by both ${comparison.declinedByBoth}   ` +
      `unmatched ${comparison.unmatched}`,
  );

  const perSkill = agreementBySkill(comparison.pairs);
  for (const [skill, skillStats] of Object.entries(perSkill)) {
    console.log(`    ${summaryRow(skill, skillStats)}`);
  }

  if (comparison.severe.length > 0) {
    console.log(`  two or more levels apart (${comparison.severe.length}):`);
    for (const row of comparison.severe) {
      console.log(`    ${row.caseId.padEnd(12)} ${row.skillCode.padEnd(26)} ${row.a} vs ${row.b}`);
    }
  }
  if (comparison.declinedByOne.length > 0) {
    console.log(`  one side declined to grade (${comparison.declinedByOne.length}):`);
    for (const row of comparison.declinedByOne) {
      console.log(`    ${row.caseId.padEnd(12)} ${row.skillCode.padEnd(26)} ${row.a} vs ${row.b}`);
    }
  }
}

/**
 * Per cell, which of the three raters stood alone.
 *
 * This is the view that decides *what to fix*, and pairwise kappa cannot show
 * it. When the model disagrees with a human, the pairwise number says only that
 * they differ — it cannot say which one was wrong, so the reflex is to "correct"
 * the prompt toward whichever human wrote the reference. That reflex is how a
 * grader gets tuned to one person's habits and called accurate.
 *
 * With a third sheet the question becomes answerable. A criterion where the
 * model and the blind human agree against the reference is not a model defect;
 * it is a reference level to revisit, or a level descriptor two readers read two
 * ways. A criterion where the model stands alone is the one a prompt revision
 * should target.
 */
function outlierBreakdown(
  author: RaterGrades,
  qa: RaterGrades,
  ai: RaterGrades,
): void {
  let comparable = 0;
  let unanimous = 0;
  const aloneBy: Record<"author" | "qa" | "ai", number> = { author: 0, qa: 0, ai: 0 };
  const authorAlone: { caseId: string; skillCode: string; a: number; q: number; m: number }[] = [];

  for (const [caseId, cells] of Object.entries(author)) {
    for (const skill of Object.keys(cells) as WrittenSkillCode[]) {
      const a = cells[skill];
      const q = qa[caseId]?.[skill];
      const m = ai[caseId]?.[skill];
      // Only cells all three put a number on. A declined cell is a real
      // judgement (see `RaterLevel`) but it has no position on the scale, so it
      // cannot be "the odd one out" of an ordinal comparison.
      if (typeof a !== "number" || typeof q !== "number" || typeof m !== "number") continue;

      comparable += 1;
      if (a === q && q === m) {
        unanimous += 1;
      } else if (q === m) {
        aloneBy.author += 1;
        authorAlone.push({ caseId, skillCode: skill, a, q, m });
      } else if (a === m) {
        aloneBy.qa += 1;
      } else if (a === q) {
        aloneBy.ai += 1;
      }
      // else: all three differ — counted in `comparable`, attributed to nobody.
    }
  }

  console.log(`\n${"─".repeat(72)}`);
  console.log("Who stood alone (cells all three raters scored)");
  console.log(`  comparable          ${comparable}`);
  console.log(`  all three agree     ${unanimous} (${((unanimous / comparable) * 100).toFixed(1)}%)`);
  console.log(`  reference alone     ${aloneBy.author}   ← revisit the level, not the prompt`);
  console.log(`  QA alone            ${aloneBy.qa}`);
  console.log(`  AI alone            ${aloneBy.ai}   ← the prompt's actual error budget`);

  const bySkill = new Map<string, number>();
  for (const row of authorAlone) {
    bySkill.set(row.skillCode, (bySkill.get(row.skillCode) ?? 0) + 1);
  }
  if (bySkill.size > 0) {
    console.log("  reference-alone cells by criterion:");
    for (const [skill, count] of [...bySkill].sort((x, y) => y[1] - x[1])) {
      console.log(`    ${skill.padEnd(26)} ${count}`);
    }
  }
}

async function main(): Promise<void> {
  const author = authorGrades();
  const qa = QA_INDEPENDENT_GRADES;
  const { grades: ai, nonVerdict } = await aiGradesFromRun();

  console.log(`Dataset ${DATASET_NAME}   run ${runName}`);
  console.log(`Cases ${EVAL_CASES.length}   AI non-verdicts ${nonVerdict.size}`);
  console.log(`\n${"col".padEnd(26)} ${"n".padStart(4)}  ${"kappa".padStart(6)}  ${"exact".padStart(6)}  ${"±1".padStart(6)}  ${"bias".padStart(7)}`);

  const humanCeiling = compareRaters(author, qa);
  const aiVsAuthor = compareRaters(author, ai);
  const aiVsQa = compareRaters(qa, ai);

  console.log(summaryRow("human ceiling (A vs QA)", agreementStats(humanCeiling.pairs)));
  console.log(summaryRow("AI vs author", agreementStats(aiVsAuthor.pairs)));
  console.log(summaryRow("AI vs QA", agreementStats(aiVsQa.pairs)));

  describe("Human ceiling — author vs QA (bias: + means QA grades easier)", humanCeiling);
  describe("AI vs author (bias: + means AI grades easier)", aiVsAuthor);
  describe("AI vs QA (bias: + means AI grades easier)", aiVsQa);

  outlierBreakdown(author, qa, ai);

  console.log(`\n${"─".repeat(72)}`);
  console.log("Confusion, author (rows) vs QA (cols) — where the rubric is ambiguous");
  for (const [level, row] of confusionMatrix(humanCeiling.pairs).entries()) {
    console.log(`  ${level}: ${row.map((n) => String(n).padStart(4)).join("")}`);
  }

  const ceiling = agreementStats(humanCeiling.pairs).quadraticKappa;
  const best = Math.max(
    agreementStats(aiVsAuthor.pairs).quadraticKappa,
    agreementStats(aiVsQa.pairs).quadraticKappa,
  );
  console.log(
    `\nAI reaches ${((best / ceiling) * 100).toFixed(0)}% of the human–human ceiling ` +
      `(${best.toFixed(3)} / ${ceiling.toFixed(3)}).`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
