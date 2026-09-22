/**
 * Wiring: what the verdict endpoints talk to at runtime.
 *
 * Same shape as `src/lib/events/runtime.ts` and `src/lib/growth/runtime.ts`,
 * and separate from `verdict-store.ts` for the same reason: importing the types
 * must not drag `pg` into a bundle, and a route must be able to ask "is there a
 * database?" without one being invented for it.
 *
 * There is no in-memory fallback here on purpose. `MemoryLearningStore` exists
 * so a child's work survives a dev hot-reload; a verdict and a teacher's
 * correction are the two things this company cannot afford to lose to a process
 * restart, so when there is no database the honest answer is 503 and not a
 * store that forgets.
 */

import { Pool } from "pg";

import type { SqlExecutor } from "@/lib/db/sql";
import { env } from "@/lib/env";

import { SqlVerdictStore, type VerdictStore } from "./verdict-store";

let override: VerdictStore | null = null;

/** Point the verdict endpoints at a specific store. Pass `null` to clear it. */
export function setVerdictStore(store: VerdictStore | null): void {
  override = store;
}

/** As above, but from a raw executor — the usual form in a test. */
export function setVerdictDb(db: SqlExecutor | null): void {
  override = db ? new SqlVerdictStore(db) : null;
}

/** The store for this request, or null when there is no database to write to. */
export function resolveVerdictStore(): VerdictStore | null {
  if (override) return override;
  if (!env.DATABASE_URL) return null;

  const cache = globalThis as unknown as { steamkidVerdictPool?: Pool };
  cache.steamkidVerdictPool ??= new Pool({ connectionString: env.DATABASE_URL });
  return new SqlVerdictStore(cache.steamkidVerdictPool);
}
