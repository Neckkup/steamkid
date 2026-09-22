/**
 * Run the grading eval set against the live grader and report agreement.
 *
 *   npm run eval:grading -- --push-dataset   # upsert the set into Langfuse
 *   npm run eval:grading -- --run            # grade every case, score the run
 *   npm run eval:grading -- --run --limit 6  # a cheap smoke over 6 cases
 *
 * The dataset, the runs and the per-item scores live in **Langfuse Datasets**.
 * This script does not store results anywhere of its own — it uploads, calls
 * the grader through the normal traced path, links each trace to its dataset
 * item, and writes scores back. What it prints is arithmetic over the run it
 * just did (`src/lib/learning/eval/agreement.ts`), not a second copy of the
 * evaluation history.
 *
 * Costs real money: every case is one Gemini call. `--limit` exists so a wiring
 * change can be checked for a cent before a full run.
 */
import { randomUUID } from "node:crypto";

import { getItemById, isWrittenItem, type WrittenItem } from "@/content";
import { gradeWritten, type AiVerdict } from "@/lib/learning/ai-grade";
import { resolveRubric } from "@/lib/learning/rubric";
import { assertUniqueCaseIds, EVAL_CASES, type EvalCase } from "@/lib/learning/eval/cases";
import {
  agreementBySkill,
  agreementStats,
  confusionMatrix,
  kappaLabel,
  type LevelPair,
} from "@/lib/learning/eval/agreement";
import { getLangfuse } from "@/lib/observability/langfuse";

/** Stable across runs — a new name would orphan the run history. */
const DATASET_NAME = "written-grading-v1";

const args = process.argv.slice(2);
const pushDataset = args.includes("--push-dataset");
const run = args.includes("--run");
const limitArg = args.indexOf("--limit");
const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : Infinity;
const labelArg = args.indexOf("--label");
const promptLabel = labelArg >= 0 ? args[labelArg + 1] : undefined;
const runNameArg = args.indexOf("--run-name");
const runName =
  runNameArg >= 0
    ? args[runNameArg + 1]
    : `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;

/** Four at a time: fast enough to be usable, gentle enough not to trip a 429. */
const CONCURRENCY = 4;

async function resolveCases(): Promise<{ case: EvalCase; item: WrittenItem }[]> {
  const out: { case: EvalCase; item: WrittenItem }[] = [];
  for (const evalCase of EVAL_CASES) {
    const found = await getItemById(evalCase.itemId);
    if (!found) throw new Error(`Eval case ${evalCase.id} names unknown item ${evalCase.itemId}`);
    const item = found.item;
    if (!isWrittenItem(item)) {
      throw new Error(`Eval case ${evalCase.id} points at ${item.type}, which is not AI-graded.`);
    }

    // The reference must cover exactly the skills the item is weighted on, or
    // the agreement number is computed over a different set of criteria than
    // the grader was asked for — a comparison that looks valid and is not.
    const resolved = resolveRubric(item);
    const expected = resolved.criteria.map(({ criterion }) => criterion.skillCode).sort();
    const got = Object.keys(evalCase.reference).sort();
    if (expected.join() !== got.join()) {
      throw new Error(
        `Eval case ${evalCase.id}: reference has [${got.join(", ")}], ` +
          `item is weighted on [${expected.join(", ")}].`,
      );
    }
    out.push({ case: evalCase, item });
  }
  return out;
}

async function pushDatasetToLangfuse(
  resolved: { case: EvalCase; item: WrittenItem }[],
): Promise<void> {
  const langfuse = getLangfuse();
  if (!langfuse) throw new Error("Langfuse is not configured; cannot push the dataset.");

  await langfuse.createDataset({
    name: DATASET_NAME,
    description:
      "PRO-8 written-grading eval. Synthetic learner answers with human reference " +
      "levels per rubric criterion. Contains no real child text — see " +
      "src/lib/learning/eval/cases.ts for why, and for the upper-bound caveat.",
    metadata: { source: "src/lib/learning/eval/cases.ts", synthetic: true },
  });

  for (const { case: evalCase, item } of resolved) {
    await langfuse.createDatasetItem({
      datasetName: DATASET_NAME,
      id: evalCase.id,
      input: {
        itemId: evalCase.itemId,
        rubricCode: item.rubricCode,
        taskPrompt: item.prompt,
        answer: evalCase.answer,
      },
      expectedOutput: {
        criteria: evalCase.reference,
        ...(evalCase.expect ?? {}),
      },
      metadata: { note: evalCase.note, synthetic: true },
    });
  }

  await langfuse.flushAsync();
  console.log(`Pushed ${resolved.length} items to dataset "${DATASET_NAME}".`);
}

interface CaseResult {
  readonly case: EvalCase;
  readonly verdict: AiVerdict;
}

async function gradeAll(
  resolved: { case: EvalCase; item: WrittenItem }[],
): Promise<CaseResult[]> {
  const langfuse = getLangfuse();
  const results: CaseResult[] = [];
  const queue = [...resolved];

  async function worker() {
    for (;;) {
      const next = queue.shift();
      if (!next) return;

      // A fresh correlation id per case, and deliberately no `learnerRef`:
      // these answers belong to no child, so attaching a learner id would put a
      // fake subject on a real trace.
      const correlationId = randomUUID();
      const verdict = await gradeWritten({
        item: next.item,
        submissionText: next.case.answer,
        correlationId,
        promptLabel,
        tags: ["eval", DATASET_NAME, runName],
      });

      results.push({ case: next.case, verdict });

      if (langfuse && verdict.traceId) {
        await langfuse.createDatasetRunItem({
          runName,
          datasetItemId: next.case.id,
          traceId: verdict.traceId,
          metadata: { status: verdict.status },
        });

        // Scores go on the trace in Langfuse, which is what makes a run
        // comparable to the next one in the UI without re-running this script.
        if (verdict.status === "graded") {
          for (const criterion of verdict.criteria) {
            const reference = next.case.reference[criterion.skillCode];
            if (reference === undefined) continue;
            langfuse.score({
              traceId: verdict.traceId,
              name: `level-delta.${criterion.skillCode}`,
              value: criterion.level - reference,
              comment: `ai=${criterion.level} human=${reference}`,
            });
          }
          langfuse.score({
            traceId: verdict.traceId,
            name: "exact-agreement",
            value:
              verdict.criteria.filter(
                (c) => c.level === next.case.reference[c.skillCode],
              ).length / verdict.criteria.length,
          });
        } else {
          langfuse.score({
            traceId: verdict.traceId,
            name: "non-verdict",
            value: 1,
            comment: verdict.status,
          });
        }
      }

      process.stdout.write(
        `${results.length}/${resolved.length} ${next.case.id} → ${verdict.status}\n`,
      );
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  await langfuse?.flushAsync();
  return results;
}

function report(results: CaseResult[]): void {
  const pairs: LevelPair[] = [];
  let costTotal = 0;
  let costed = 0;
  let latencyTotal = 0;
  const byStatus = new Map<string, number>();
  const bandRows: { id: string; delta: number }[] = [];

  for (const { case: evalCase, verdict } of results) {
    byStatus.set(verdict.status, (byStatus.get(verdict.status) ?? 0) + 1);
    if (verdict.costUsd !== null) {
      costTotal += verdict.costUsd;
      costed += 1;
    }
    latencyTotal += verdict.latencyMs;

    if (verdict.status !== "graded") continue;
    for (const criterion of verdict.criteria) {
      const reference = evalCase.reference[criterion.skillCode];
      if (reference === undefined) continue;
      pairs.push({
        skillCode: criterion.skillCode,
        reference,
        predicted: criterion.level,
      });
      bandRows.push({ id: evalCase.id, delta: criterion.level - reference });
    }
  }

  const overall = agreementStats(pairs);
  const perSkill = agreementBySkill(pairs);

  console.log(`\n${"=".repeat(64)}`);
  console.log(`Dataset: ${DATASET_NAME}   Run: ${runName}`);
  console.log(`Cases: ${results.length}   Criterion comparisons: ${overall.n}`);
  console.log(
    `Statuses: ${[...byStatus.entries()].map(([s, n]) => `${s}=${n}`).join("  ")}`,
  );
  console.log("-".repeat(64));
  console.log(
    `Quadratic weighted kappa : ${overall.quadraticKappa.toFixed(3)} (${kappaLabel(
      overall.quadraticKappa,
    )})`,
  );
  console.log(`Exact level agreement    : ${(overall.exact * 100).toFixed(1)}%`);
  console.log(`Within one level         : ${(overall.within1 * 100).toFixed(1)}%`);
  console.log(
    `Mean signed error        : ${overall.meanSignedError >= 0 ? "+" : ""}${overall.meanSignedError.toFixed(
      3,
    )} (${overall.meanSignedError > 0 ? "AI grades easier" : "AI grades harder"})`,
  );
  console.log(`Mean absolute error      : ${overall.meanAbsoluteError.toFixed(3)}`);

  console.log("\nPer skill (worst kappa first):");
  for (const [skill, stats] of Object.entries(perSkill)) {
    console.log(
      `  ${skill.padEnd(26)} n=${String(stats.n).padStart(3)}  ` +
        `kappa=${stats.quadraticKappa.toFixed(3).padStart(6)}  ` +
        `exact=${(stats.exact * 100).toFixed(0).padStart(3)}%  ` +
        `bias=${stats.meanSignedError >= 0 ? "+" : ""}${stats.meanSignedError.toFixed(2)}`,
    );
  }

  console.log("\nConfusion (rows = human level, cols = AI level):");
  const matrix = confusionMatrix(pairs);
  console.log("        ai=0  ai=1  ai=2  ai=3");
  matrix.forEach((row, level) => {
    console.log(
      `  h=${level}  ` + row.map((n) => String(n).padStart(5)).join(" "),
    );
  });

  console.log("\nWorst disagreements:");
  bandRows
    .filter((r) => Math.abs(r.delta) >= 2)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 10)
    .forEach((r) => console.log(`  ${r.id.padEnd(14)} delta=${r.delta > 0 ? "+" : ""}${r.delta}`));

  // Flag checks. These are pass/fail behaviours, not levels, so they are
  // reported separately from kappa — an injection that slipped through is not
  // "a bit of disagreement", it is a defect.
  const injectionCases = results.filter((r) => r.case.expect?.instructionAttempt);
  const injectionCaught = injectionCases.filter(
    (r) => r.verdict.status === "graded" && r.verdict.instructionAttempt,
  );
  const unscorableCases = results.filter((r) => r.case.expect?.unscorable);
  const unscorableCaught = unscorableCases.filter((r) => r.verdict.status === "unscorable");

  console.log("\nBehaviour checks:");
  console.log(
    `  instruction attempts flagged : ${injectionCaught.length}/${injectionCases.length}`,
  );
  for (const r of injectionCases) {
    const ok = r.verdict.status === "graded" && r.verdict.instructionAttempt;
    console.log(`    ${ok ? "✓" : "✗"} ${r.case.id} (${r.verdict.status})`);
  }
  console.log(
    `  unscorable routed to teacher : ${unscorableCaught.length}/${unscorableCases.length}`,
  );
  for (const r of unscorableCases) {
    const reason = r.verdict.status === "unscorable" ? r.verdict.reason : r.verdict.status;
    console.log(`    ${r.verdict.status === "unscorable" ? "✓" : "✗"} ${r.case.id} (${reason})`);
  }

  console.log("\nCost and latency:");
  if (costed === 0) {
    console.log("  no priced calls — check the rate card in src/lib/ai/models.ts");
  } else {
    console.log(`  total            : $${costTotal.toFixed(6)} over ${costed} priced calls`);
    console.log(`  per graded item  : $${(costTotal / costed).toFixed(6)}`);
  }
  console.log(`  mean latency     : ${Math.round(latencyTotal / results.length)} ms`);
  console.log(`${"=".repeat(64)}\n`);
}

async function main() {
  assertUniqueCaseIds();
  const resolved = await resolveCases();
  console.log(`${resolved.length} eval cases resolve against the content and their rubrics.`);

  if (pushDataset) await pushDatasetToLangfuse(resolved);

  if (!run) {
    if (!pushDataset) {
      console.log("Nothing to do. Pass --push-dataset and/or --run.");
    }
    return;
  }

  const selected = Number.isFinite(limit) ? resolved.slice(0, limit) : resolved;
  console.log(`Grading ${selected.length} case(s) as run "${runName}"…\n`);
  const results = await gradeAll(selected);
  report(results);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
