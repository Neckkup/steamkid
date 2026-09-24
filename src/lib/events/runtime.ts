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

/**
 * Node.js syscall codes and PostgreSQL SQLSTATE codes that mean the server is
 * unreachable. We catch these to surface a 503 rather than a 500.
 */
const UNAVAILABLE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "08000", // connection_exception
  "08006", // connection_failure
  "57P03", // cannot_connect_now (server is starting up)
]);

/** True when an error thrown by `pg` means the database is unreachable. */
export function isDbUnavailableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  return Boolean(code && UNAVAILABLE_CODES.has(code));
}

/**
 * Quick reachability probe — runs a `SELECT 1` against the behaviour pool.
 *
 * Returns true only when a query succeeds, so both `/api/health` and the events
 * ingest path share the same definition of "database is up".
 */
export async function probeBehaviourDb(): Promise<boolean> {
  const db = getBehaviourDb();
  if (!db) return false;
  try {
    await db.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

/**
 * Distinguishes "no override installed" (use `DATABASE_URL`) from "override
 * explicitly set to null" (return null, used by tests that need the DB absent).
 * Without the sentinel, `setBehaviourDb(null)` would fall through to the pool
 * even when DATABASE_URL is set in the environment.
 */
const NOT_SET = Symbol("not-set");
let override: SqlExecutor | null | typeof NOT_SET = NOT_SET;

/**
 * Point the ingest path at a specific database instead of `DATABASE_URL`.
 *
 * The counterpart to `setEventSink`, and needed for the same reason: the
 * endpoint resolves the learner behind the cookie with real SQL, so a test that
 * only installs a sink still has no learner to attribute a batch to. Passing
 * the PGlite fixture here lets `POST /api/events` be driven end to end without
 * a connection string existing anywhere. Pass `null` to disable the DB
 * explicitly — this is different from "not overridden" and means the pool from
 * `DATABASE_URL` is not used either.
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
  if (override !== NOT_SET) return override;
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
