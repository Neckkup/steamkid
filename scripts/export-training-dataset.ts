/**
 * Training dataset export — PRO-10.
 *
 * Queries the consent-filtered `ml.*` views and writes one JSONL file per
 * dataset kind. Logs an `ml.training_export_run` row so every export is
 * auditable. Verifies that no PII fields (learner_id, email, display_name)
 * appear in the output before writing.
 *
 * Usage:
 *
 *   npm run export:training -- --kind grading --out /tmp/grading.jsonl
 *   npm run export:training -- --kind behaviour --out /tmp/behaviour.jsonl
 *   npm run export:training -- --kind growth --out /tmp/growth.jsonl
 *   npm run export:training -- --kind grading --dry-run   # count rows, no file
 *
 * Needs RUNTIME_DATABASE_URL or DATABASE_URL.
 *
 * ## Field documentation
 *
 * ### grading (ml.v_grading_examples)
 *
 * | Field                  | Type     | Description |
 * |------------------------|----------|-------------|
 * | learner_ref            | uuid     | Pseudonymous learner id (rotatable). Never the internal PK. |
 * | grade_band             | text     | The learner's year group (e.g. "p5"). |
 * | verdict_id             | uuid     | Stable identifier for this grading record. |
 * | correlation_id         | uuid     | Ties to behaviour events and the Langfuse trace. |
 * | prompt                 | text     | The exercise question the child answered. |
 * | item_type              | text     | One of: short_text, long_text. |
 * | difficulty             | int      | 1–3. |
 * | skill_weights          | object   | Rubric skill codes → weight (sum ≤ 1). |
 * | rubric                 | object   | Full rubric criteria JSON from rubric_version. |
 * | learner_answer_redacted    | object   | The redacted answer snapshot used by the model. |
 * | effective_scores           | object   | Per-skill map: {score, max, weight, ai_score, teacher_corrected, reason}. `ai_score` is what the model gave; `score` is what counts (teacher override if present). |
 * | ai_normalized_score        | numeric  | Weighted 0–1 score the AI computed before any teacher correction. |
 * | effective_normalized_score | numeric  | Weighted 0–1 score after applying any teacher corrections. |
 * | teacher_corrected          | boolean  | True when at least one skill was corrected by a teacher. |
 * | corrected_skill_count      | int      | How many skills the teacher changed. |
 * | instruction_attempt        | boolean  | True when the child's text appeared to instruct the grader. |
 * | model                      | text     | The model id used for grading (e.g. "gemini-3.8-flash"). |
 * | prompt_name                | text     | Langfuse prompt name (e.g. "grading/sci-cer-short"). |
 * | prompt_version             | int      | Langfuse prompt version number. |
 * | rubric_version             | text     | Rubric version tag (e.g. "SCI_CER_SHORT@1"). |
 * | grade_version              | text     | Grading engine version (e.g. "ai-grade@1"). |
 * | redaction_version          | text     | Which redaction pass was applied. |
 * | created_at                 | timestamptz | When the verdict was written. |
 *
 * ### behaviour (ml.v_behaviour_sequences)
 *
 * | Field               | Type     | Description |
 * |---------------------|----------|-------------|
 * | learner_ref         | uuid     | Pseudonymous learner id. |
 * | grade_band          | text     | Year group. |
 * | session_id          | uuid     | All events in one sitting share this id. |
 * | session_started_at  | timestamptz | When the session started. |
 * | session_active_ms   | bigint   | Active (non-idle) ms in this session. |
 * | client_seq          | bigint   | Monotonic client sequence number. Sort by this within a session. |
 * | event_time          | timestamptz | When the event occurred on the client. |
 * | event_name          | text     | Registered event name (e.g. "item.answered"). |
 * | event_version       | int      | Schema version of the payload. |
 * | lesson_id           | uuid     | Lesson the event is associated with, if any. |
 * | item_id             | uuid     | Exercise item the event is associated with, if any. |
 * | submission_id       | uuid     | Submission the event is associated with, if any. |
 * | correlation_id      | uuid     | Ties to verdict and Langfuse trace. |
 * | payload             | object   | Event-specific data. Schema defined by the event registry. |
 *
 * ### growth (ml.v_growth_labels)
 *
 * | Field                | Type     | Description |
 * |----------------------|----------|-------------|
 * | learner_ref          | uuid     | Pseudonymous learner id. |
 * | grade_band           | text     | Year group. |
 * | skill_code           | text     | Skill code (e.g. "SCI.CER.CLAIM"). |
 * | snapshot_at          | timestamptz | When this snapshot was computed. |
 * | mastery              | numeric  | 0–1 EWMA mastery score. |
 * | confidence           | numeric  | 0–1 confidence in the mastery estimate. |
 * | assist_index         | numeric  | How often this learner needed help (0–1). |
 * | evidence_count       | int      | Number of evidence points in this estimate. |
 * | growth_label         | text     | One of: improving, steady, declining, insufficient_evidence. |
 * | growth_kind          | text     | mastery or efficiency (when label is "improving"). |
 * | growth_delta         | numeric  | Mastery change over the measurement window. |
 * | reason_codes         | text[]   | Codes driving the growth label. |
 * | growth_model_version | text     | Which growth model produced this snapshot. |
 */

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

import { Pool } from "pg";

import { pgConnectionOptions } from "../src/lib/db/pg-connection";
import { resolveRuntimeUrl } from "../src/lib/db/connection-env";
import { uuidv7 } from "../src/lib/ids";

const SPEC_VERSION = "v1";
const REDACTION_VERSION = "redact@1";

// PII fields that must never appear in the output.
const PII_FIELD_BLOCKLIST = new Set([
  "learner_id",
  "email",
  "display_name",
  "auth_subject_id",
  "guardian_user_id",
  "teacher_user_id",
]);

type DatasetKind = "grading" | "behaviour" | "growth";

const QUERIES: Record<DatasetKind, string> = {
  grading: `
    SELECT learner_ref, grade_band, verdict_id, correlation_id,
           item_id, attempt_number, prompt, item_type, difficulty,
           skill_weights, rubric, learner_answer_redacted,
           effective_scores, ai_normalized_score,
           effective_normalized_score, teacher_corrected,
           corrected_skill_count, instruction_attempt,
           model, prompt_name, prompt_version,
           rubric_version, grade_version, redaction_version, created_at
    FROM ml.v_grading_examples
    ORDER BY created_at
  `,
  behaviour: `
    SELECT learner_ref, grade_band, session_id, session_started_at,
           session_active_ms, client_seq, event_time, event_name,
           event_version, lesson_id, item_id, submission_id,
           correlation_id, payload
    FROM ml.v_behaviour_sequences
    ORDER BY session_id, client_seq
  `,
  growth: `
    SELECT learner_ref, grade_band, skill_code, snapshot_at,
           mastery, confidence, assist_index, evidence_count,
           growth_label, growth_kind, growth_delta, reason_codes,
           growth_model_version
    FROM ml.v_growth_labels
    ORDER BY learner_ref, skill_code, snapshot_at
  `,
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const kindArg = args.indexOf("--kind");
const outArg = args.indexOf("--out");
const dryRun = args.includes("--dry-run");

if (kindArg === -1 || !["grading", "behaviour", "growth"].includes(args[kindArg + 1] ?? "")) {
  console.error("Usage: --kind grading|behaviour|growth [--out <path>] [--dry-run]");
  process.exit(1);
}

const kind = args[kindArg + 1] as DatasetKind;
const outPath = outArg >= 0 ? resolve(args[outArg + 1]!) : null;

if (!dryRun && !outPath) {
  console.error("Pass --out <path> or --dry-run");
  process.exit(1);
}

const resolved = resolveRuntimeUrl(process.env);
if (!resolved) {
  console.error("RUNTIME_DATABASE_URL or DATABASE_URL is required");
  process.exit(1);
}

const pool = new Pool(pgConnectionOptions(resolved.url));

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    const consentSnapshotAt = new Date();

    // Stream rows via cursor to avoid loading the whole table into memory.
    await client.query("BEGIN");
    await client.query(
      `DECLARE export_cursor NO SCROLL CURSOR FOR ${QUERIES[kind]}`,
    );

    const rows: Record<string, unknown>[] = [];
    const hash = createHash("sha256");

    while (true) {
      const { rows: batch } = await client.query<Record<string, unknown>>(
        "FETCH 500 FROM export_cursor",
      );
      if (batch.length === 0) break;

      for (const row of batch) {
        assertNoPii(row);
        rows.push(row);
        hash.update(JSON.stringify(row) + "\n");
      }
    }

    await client.query("CLOSE export_cursor");
    await client.query("COMMIT");

    const checksum = hash.digest("hex");

    console.log(`Kind:     ${kind}`);
    console.log(`Rows:     ${rows.length}`);
    console.log(`Checksum: ${checksum}`);

    if (dryRun) {
      console.log("(dry run — no file written)");
      return;
    }

    // Write JSONL.
    await pipeline(
      Readable.from(rows.map((r) => JSON.stringify(r) + "\n")),
      createWriteStream(outPath!),
    );
    console.log(`Written:  ${outPath}`);

    // Log the export run.
    await logExportRun({
      kind,
      rowCount: rows.length,
      outputUri: `file://${outPath}`,
      checksum,
      consentSnapshotAt,
    });

    // Print field docs.
    printFieldDocs(kind);
  } finally {
    client.release();
    await pool.end();
  }
}

function assertNoPii(row: Record<string, unknown>): void {
  for (const key of Object.keys(row)) {
    if (PII_FIELD_BLOCKLIST.has(key)) {
      throw new Error(
        `PII field "${key}" found in export row. The ml.* view definition must be ` +
          `updated to exclude it before any export can proceed.`,
      );
    }
  }
}

async function logExportRun(params: {
  kind: DatasetKind;
  rowCount: number;
  outputUri: string;
  checksum: string;
  consentSnapshotAt: Date;
}): Promise<void> {
  const id = uuidv7();
  await pool.query(
    `INSERT INTO ml.training_export_run
       (id, spec_version, dataset_kind, filters, consent_snapshot_at,
        row_count, output_uri, checksum, redaction_version)
     VALUES ($1::uuid, $2::text, $3::text, $4::jsonb, $5::timestamptz,
             $6::int, $7::text, $8::text, $9::text)`,
    [
      id,
      SPEC_VERSION,
      params.kind,
      JSON.stringify({}),
      params.consentSnapshotAt.toISOString(),
      params.rowCount,
      params.outputUri,
      params.checksum,
      REDACTION_VERSION,
    ],
  );
  console.log(`Export run logged: ${id}`);
}

function printFieldDocs(kind: DatasetKind): void {
  const docs: Record<DatasetKind, string> = {
    grading: "See script header: ## Field documentation > grading",
    behaviour: "See script header: ## Field documentation > behaviour",
    growth: "See script header: ## Field documentation > growth",
  };
  console.log(`\nField docs: ${docs[kind]}`);
  console.log("Full schema: scripts/export-training-dataset.ts (top-of-file JSDoc)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
