import { NextResponse } from "next/server";

import { env, isLangfuseConfigured, isSentryConfigured } from "@/lib/env";
import { probeBehaviourDb } from "@/lib/events/runtime";

export const dynamic = "force-dynamic";

/**
 * Deployment self-check. QA and the team use this URL to tell whether a
 * preview is wired up, without needing dashboard access.
 *
 * Reports only booleans — never a key, a host, or a connection string.
 *
 * `database` reflects a real `SELECT 1` against the behaviour pool, not just
 * whether `DATABASE_URL` is set. A pool exists the moment the env var appears,
 * but a connection is only attempted on the first query — which is why the old
 * `isDatabaseConfigured` flag read `true` even when Postgres was unreachable.
 */
export async function GET() {
  return NextResponse.json({
    status: "ok",
    appEnv: env.APP_ENV,
    checkedAt: new Date().toISOString(),
    integrations: {
      database: await probeBehaviourDb(),
      langfuse: isLangfuseConfigured,
      sentry: isSentryConfigured,
    },
  });
}
