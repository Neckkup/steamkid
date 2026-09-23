/**
 * `POST /api/internal/sweep-sessions`
 *
 * Closes sessions the client never explicitly ended — tablets that ran out of
 * battery, tabs closed without a `pagehide`, or network drops mid-session.
 *
 * `reconstructSession` applies rule 3 (silence ≥ 30 minutes → idle_close) when
 * an `asOf` time is passed. This endpoint provides that timestamp and drives the
 * sweep, so a session that died silently is not left open forever.
 *
 * **Run this on a 5–10 minute cron.** The worst-case lag between a silent
 * session ending and it becoming scorable is one cadence interval beyond the
 * 30-minute idle threshold.
 *
 * Security: requires `Authorization: Bearer <INTERNAL_CRON_SECRET>` unless
 * `APP_ENV=local`.
 */

import { NextResponse } from "next/server";

import { env } from "@/lib/env";
import { getBehaviourDb } from "@/lib/events/runtime";
import { PostgresEventSink } from "@/lib/events/pg-sink";

export const dynamic = "force-dynamic";

const SWEEP_LIMIT = 500;

export async function POST(request: Request): Promise<Response> {
  if (!checkAuth(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = getBehaviourDb();
  if (!db) {
    return NextResponse.json({ error: "database_unavailable" }, { status: 503 });
  }

  const sink = new PostgresEventSink(db);
  const asOf = new Date();
  const swept = await sink.sweepIdleSessions(asOf, SWEEP_LIMIT);

  return NextResponse.json({ swept, asOf: asOf.toISOString() }, { status: 200 });
}

function checkAuth(request: Request): boolean {
  // Local dev: no secret configured → allow without auth.
  if (env.APP_ENV === "local" && !env.INTERNAL_CRON_SECRET) return true;

  const secret = env.INTERNAL_CRON_SECRET;
  if (!secret) {
    // Secret should always be configured in non-local environments.
    console.error("INTERNAL_CRON_SECRET is not set; refusing sweep request");
    return false;
  }

  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return token === secret;
}
