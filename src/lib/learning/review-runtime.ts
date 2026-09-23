/**
 * Wiring: what the teacher review screens read from.
 *
 * Same three-step shape as `verdict-runtime.ts` and `growth/runtime.ts` — an
 * installed executor wins, then `DATABASE_URL`, then nothing — with one extra
 * step at the end that is worth explaining.
 *
 * On a laptop there is no Postgres yet (PRO-12), and the growth dashboard
 * already solves that with an opt-in PGlite database seeded from the real
 * migrations. The review screens read `app.ai_verdict` out of the same rows, so
 * they reuse that database rather than starting a second one. When they do,
 * this module also points the `/api/verdicts/:id/override` endpoints at it via
 * `setVerdictDb`, because otherwise the page would render a verdict the API
 * could not find and every save would answer 503.
 *
 * The demo path cannot reach a deployed tier: it needs `STEAMKID_DEV_DB=pglite`
 * and a non-production `APP_ENV`, and `isDemoDatabase()` puts a banner on every
 * screen it feeds.
 */

import { pgConnectionOptions } from "@/lib/db/pg-connection";
import type { SqlExecutor } from "@/lib/db/sql";
import { env } from "@/lib/env";
import { resolveDemoDb } from "@/lib/growth/runtime";

import { SqlReviewQueue, type ReviewQueue } from "./review-queue";
import { setVerdictDb } from "./verdict-runtime";

let override: SqlExecutor | null = null;

/** Point the review screens at a specific database. Pass `null` to clear it. */
export function setReviewDb(db: SqlExecutor | null): void {
  override = db;
}

async function reviewDb(): Promise<SqlExecutor | null> {
  if (override) return override;

  // Demo first, matching `growth/runtime.ts`: the flag is an explicit developer
  // request that cannot be set in production, and preferring a `DATABASE_URL`
  // nobody is running would make it unusable exactly where it is needed.
  const demo = await resolveDemoDb();
  if (demo) {
    // The override endpoints resolve their own store and would otherwise find
    // no database at all in demo mode.
    setVerdictDb(demo);
    return demo;
  }

  if (env.DATABASE_URL) {
    const { Pool } = await import("pg");
    const cache = globalThis as unknown as { steamkidReviewPool?: InstanceType<typeof Pool> };
    cache.steamkidReviewPool ??= new Pool(pgConnectionOptions(env.DATABASE_URL));
    return cache.steamkidReviewPool;
  }

  return null;
}

/** The review queue for this request, or null when there is nothing to read. */
export async function resolveReviewQueue(): Promise<ReviewQueue | null> {
  const db = await reviewDb();
  return db ? new SqlReviewQueue(db) : null;
}
