import { NextResponse } from "next/server";

import {
  env,
  isDatabaseConfigured,
  isLangfuseConfigured,
  isSentryConfigured,
} from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * Deployment self-check. QA and the team use this URL to tell whether a
 * preview is wired up, without needing dashboard access.
 *
 * Reports only booleans — never a key, a host, or a connection string.
 */
export async function GET() {
  return NextResponse.json({
    status: "ok",
    appEnv: env.APP_ENV,
    checkedAt: new Date().toISOString(),
    integrations: {
      database: isDatabaseConfigured,
      langfuse: isLangfuseConfigured,
      sentry: isSentryConfigured,
    },
  });
}
