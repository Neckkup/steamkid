/**
 * Runtime wiring for the learning path engine.
 *
 * Same pattern as `verdict-runtime.ts`: the installed database lives on
 * `globalThis` so it is visible across Next.js bundles. Pass `null` to disable;
 * call `resolvePathDb()` in a route handler to get the executor.
 */

import { Pool } from "pg";

import { pgConnectionOptions } from "@/lib/db/pg-connection";
import type { SqlExecutor } from "@/lib/db/sql";
import { env } from "@/lib/env";

const installed = ((
  globalThis as unknown as { steamkidPathDb?: { db?: SqlExecutor | null } }
).steamkidPathDb ??= {}) as { db?: SqlExecutor | null };

export function setPathDb(db: SqlExecutor | null): void {
  installed.db = db;
}

export function resolvePathDb(): SqlExecutor | null {
  if (installed.db !== undefined) return installed.db;
  if (!env.DATABASE_URL) return null;
  return pathPool();
}

function pathPool(): Pool {
  const cache = globalThis as unknown as { steamkidPathPool?: Pool };
  cache.steamkidPathPool ??= new Pool(pgConnectionOptions(env.DATABASE_URL as string));
  return cache.steamkidPathPool;
}
