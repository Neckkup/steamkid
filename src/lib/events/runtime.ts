/**
 * Wiring: what `POST /api/events` talks to at runtime.
 *
 * Kept apart from `sink.ts` so that importing the sink interface does not drag
 * `pg` into a browser bundle, and so tests can install their own sink without
 * a connection string existing anywhere.
 */

import { Pool } from "pg";

import { pgConnectionOptions } from "@/lib/db/pg-connection";
import type { SqlExecutor } from "@/lib/db/sql";
import { env } from "@/lib/env";

import { PostgresEventSink } from "./pg-sink";
import { getEventSink, setEventSink, type EventSink } from "./sink";

let override: SqlExecutor | null = null;

/**
 * Point the ingest path at a specific database instead of `DATABASE_URL`.
 *
 * The counterpart to `setEventSink`, and needed for the same reason: the
 * endpoint resolves the learner behind the cookie with real SQL, so a test that
 * only installs a sink still has no learner to attribute a batch to. Passing
 * the PGlite fixture here lets `POST /api/events` be driven end to end without
 * a connection string existing anywhere. Pass `null` to clear it.
 */
export function setBehaviourDb(db: SqlExecutor | null): void {
  override = db;
}

/**
 * Shared pool for the behaviour pipe.
 *
 * Cached on `globalThis` for the same reason `src/lib/db.ts` caches Prisma: a
 * dev hot-reload must not open a second pool on every edit.
 */
export function getBehaviourDb(): SqlExecutor | null {
  if (override) return override;
  if (!env.DATABASE_URL) return null;

  const cache = globalThis as unknown as { steamkidEventPool?: Pool };
  if (!cache.steamkidEventPool) {
    cache.steamkidEventPool = new Pool(pgConnectionOptions(env.DATABASE_URL));
  }
  return cache.steamkidEventPool;
}

/**
 * The sink to use for this request.
 *
 * A sink installed by `setEventSink` wins, so a test never reaches a real
 * database by accident. Otherwise we build the Postgres sink if a connection
 * string exists, and return null if it does not — the endpoint turns that into
 * a 503 rather than accepting a batch it cannot store.
 */
export function resolveEventSink(): EventSink | null {
  const installed = getEventSink();
  if (installed) return installed;

  const db = getBehaviourDb();
  if (!db) return null;

  const sink = new PostgresEventSink(db);
  setEventSink(sink);
  return sink;
}
