import { NextResponse } from "next/server";

import {
  BatchRejectedError,
  MAX_BATCH_SIZE,
  readBatch,
  validateBatch,
  type DeadLetterRecord,
} from "@/lib/events/ingest";
import { readLearnerCookie, resolveLearnerId } from "@/lib/events/learner";
import { getBehaviourDb, isDbUnavailableError, resolveEventSink } from "@/lib/events/runtime";

export const dynamic = "force-dynamic";

/**
 * Largest request body we will read, ~3× the largest legal batch.
 *
 * Read before parsing: `JSON.parse` on an unbounded body is the cheapest way to
 * take this endpoint down from a device we do not control.
 */
const MAX_BODY_BYTES = 3 * 1024 * 1024;

/**
 * `POST /api/events` — the behaviour pipe's only entrance.
 *
 * Contract (PRO-3 ingest rules, hardened by PRO-22):
 *
 *   - batch of at most 50, `{"events": [...]}` or a bare array
 *   - every event is validated against the registry: unknown names, undeclared
 *     payload keys, wrong types and long strings at any depth are refused
 *   - refused events are dead-lettered with their shape, never their values,
 *     and counted; they are never written to the main table
 *   - a partially bad batch still returns 202. The good events are stored and
 *     the bad ones will not become good on retry, so asking the client to send
 *     them again only costs the child's battery
 *
 * Consent enforcement and de-duplication live in the sink (PRO-7): both need
 * the learner behind the session cookie, which this endpoint deliberately does
 * not take from the client.
 *
 * Three outcomes look identical from the outside, and must:
 *
 *   - stored
 *   - withheld because the guardian did not grant the scope
 *   - dropped because the cookie matches no learner
 *
 * All three answer 202 with the same body shape. A client that could tell them
 * apart could read one child's consent state from another child's browser.
 */
export async function POST(request: Request): Promise<Response> {
  const sink = resolveEventSink();
  const db = getBehaviourDb();
  if (!sink || !db) {
    // Fail closed rather than accept-and-drop: see `sink.ts`.
    return NextResponse.json({ error: "event_store_unavailable" }, { status: 503 });
  }

  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "batch_too_large" }, { status: 413 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  let batch: unknown[];
  try {
    batch = readBatch(parsed);
  } catch (error) {
    if (error instanceof BatchRejectedError) {
      return NextResponse.json(
        { error: error.reason, maxBatchSize: MAX_BATCH_SIZE },
        { status: error.reason === "batch_too_large" ? 413 : 400 },
      );
    }
    throw error;
  }

  const receivedAt = new Date().toISOString();
  const { accepted, rejected } = validateBatch(batch, receivedAt);

  const publicRef = readLearnerCookie(request.headers.get("cookie"));

  try {
    const learnerId = publicRef ? await resolveLearnerId(db, publicRef) : null;
    if (learnerId) {
      const context = { learnerId, receivedAt };
      await sink.accept(context, accepted);
      if (rejected.length > 0) {
        await sink.deadLetter(context, rejected);
      }
    }
  } catch (err) {
    if (isDbUnavailableError(err)) {
      return NextResponse.json({ error: "event_store_unavailable" }, { status: 503 });
    }
    throw err;
  }

  if (rejected.length > 0) {
    logRejections(rejected);
  }

  return NextResponse.json(
    {
      accepted: accepted.length,
      rejected: rejected.length,
      // Enough for a developer to fix the emitter, and nothing a child typed:
      // `detail` is field paths and keyword names only.
      rejections: rejected.map((record) => ({
        event_id: record.event_id,
        event_name: record.event_name,
        reason: record.reason,
        detail: record.detail,
      })),
    },
    { status: 202 },
  );
}

/**
 * One structured line per rejection.
 *
 * The dead-letter table is the record; this is the thing that makes a broken
 * emitter visible the same day instead of at the next data audit.
 */
function logRejections(records: readonly DeadLetterRecord[]): void {
  for (const record of records) {
    console.warn(
      JSON.stringify({
        at: "events.ingest.rejected",
        reason: record.reason,
        event_name: record.event_name,
        event_version: record.event_version,
        registry_version: record.registry_version,
        detail: record.detail,
        payload_shape: record.payload_shape,
      }),
    );
  }
}
