/**
 * `POST /api/internal/export-training-dataset`
 *
 * Admin endpoint to trigger a training-dataset export. Mirrors the logic in
 * `scripts/export-training-dataset.ts` but is callable from a web context and
 * returns the run metadata rather than writing a file.
 *
 * Body (JSON, all optional):
 *   kind  — "grading" | "behaviour" | "growth" | "all"  (default "all")
 *
 * Response:
 *   { exportRunId, rowCount, checksum }
 *
 * When kind = "all", all three dataset views are queried, combined into a
 * single checksum, and logged as one ml.training_export_run row with
 * dataset_kind = "all".
 *
 * Security: requires `Authorization: Bearer <INTERNAL_CRON_SECRET>` unless
 * `APP_ENV=local`.
 *
 * PII gate: any row that carries a field from the PII blocklist causes a 500
 * before any data is returned or logged. The ml.* views must exclude identity
 * structurally — this check is the belt-and-suspenders enforcement.
 */

import { createHash } from "node:crypto";

import { Pool } from "pg";

import { pgConnectionOptions } from "@/lib/db/pg-connection";
import { env } from "@/lib/env";
import { uuidv7 } from "@/lib/ids";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const SPEC_VERSION = "v1";
const REDACTION_VERSION = "redact@1";

const PII_FIELD_BLOCKLIST = new Set([
  "learner_id",
  "email",
  "display_name",
  "auth_subject_id",
  "guardian_user_id",
  "teacher_user_id",
]);

type DatasetKind = "grading" | "behaviour" | "growth";
type RequestKind = DatasetKind | "all";

const QUERIES: Record<DatasetKind, string> = {
  grading: `
    SELECT learner_ref, grade_band, verdict_id, correlation_id,
           prompt, item_type, difficulty, skill_weights, rubric,
           learner_answer_redacted, ai_scores, effective_scores,
           teacher_corrected, model, prompt_name, prompt_version,
           redaction_version, created_at
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

let pool: Pool | null = null;

function getPool(): Pool | null {
  if (!env.DATABASE_URL) return null;
  if (!pool) {
    pool = new Pool(pgConnectionOptions(env.DATABASE_URL));
  }
  return pool;
}

export async function POST(request: Request): Promise<Response> {
  if (!checkAuth(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const pg = getPool();
  if (!pg) {
    return NextResponse.json({ error: "database_unavailable" }, { status: 503 });
  }

  let kind: RequestKind = "all";
  try {
    const body = await request.json().catch(() => ({}));
    if (body?.kind !== undefined) {
      if (!["grading", "behaviour", "growth", "all"].includes(body.kind)) {
        return NextResponse.json(
          { error: "invalid_kind", detail: "kind must be grading, behaviour, growth, or all" },
          { status: 400 },
        );
      }
      kind = body.kind as RequestKind;
    }
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const kinds: DatasetKind[] = kind === "all" ? ["grading", "behaviour", "growth"] : [kind];

  const client = await pg.connect();
  try {
    const consentSnapshotAt = new Date();
    const hash = createHash("sha256");
    let totalRows = 0;

    for (const k of kinds) {
      await client.query("BEGIN");
      await client.query(`DECLARE export_cursor NO SCROLL CURSOR FOR ${QUERIES[k]}`);

      while (true) {
        const { rows: batch } = await client.query<Record<string, unknown>>(
          "FETCH 500 FROM export_cursor",
        );
        if (batch.length === 0) break;

        for (const row of batch) {
          assertNoPii(row);
          hash.update(JSON.stringify(row) + "\n");
          totalRows++;
        }
      }

      await client.query("CLOSE export_cursor");
      await client.query("COMMIT");
    }

    const checksum = hash.digest("hex");
    const exportRunId = uuidv7();

    await client.query(
      `INSERT INTO ml.training_export_run
         (id, spec_version, dataset_kind, filters, consent_snapshot_at,
          row_count, output_uri, checksum, redaction_version)
       VALUES ($1::uuid, $2::text, $3::text, $4::jsonb, $5::timestamptz,
               $6::int, $7::text, $8::text, $9::text)`,
      [
        exportRunId,
        SPEC_VERSION,
        kind,
        JSON.stringify({}),
        consentSnapshotAt.toISOString(),
        totalRows,
        null,
        checksum,
        REDACTION_VERSION,
      ],
    );

    return NextResponse.json({ exportRunId, rowCount: totalRows, checksum }, { status: 200 });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (err instanceof PiiError) {
      return NextResponse.json({ error: "pii_detected", detail: err.message }, { status: 500 });
    }
    throw err;
  } finally {
    client.release();
  }
}

class PiiError extends Error {}

function assertNoPii(row: Record<string, unknown>): void {
  for (const key of Object.keys(row)) {
    if (PII_FIELD_BLOCKLIST.has(key)) {
      throw new PiiError(
        `PII field "${key}" found in export row. The ml.* view definition must be ` +
          `updated to exclude it before any export can proceed.`,
      );
    }
  }
}

function checkAuth(request: Request): boolean {
  if (env.APP_ENV === "local" && !env.INTERNAL_CRON_SECRET) return true;

  const secret = env.INTERNAL_CRON_SECRET;
  if (!secret) {
    console.error("INTERNAL_CRON_SECRET is not set; refusing export request");
    return false;
  }

  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return token === secret;
}
