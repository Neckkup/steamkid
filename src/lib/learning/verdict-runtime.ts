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

/**
 * The installed store lives on `globalThis`, not in a module `let`.
 *
 * Next bundles pages and route handlers separately, so a module-scoped
 * singleton exists once per bundle. A store installed while a page rendered was
 * therefore invisible to `POST /api/verdicts/:id/override`, which fell through
 * to `DATABASE_URL` and answered 500 against a Postgres nobody was running —
 * the teacher review screens (PRO-77) could render a verdict they could not
 * then correct. The `pg.Pool` cache below is on `globalThis` for the same
 * reason.
 */
const installed = ((globalThis as unknown as { steamkidVerdictStore?: { store?: VerdictStore | null } })
  .steamkidVerdictStore ??= {}) as { store?: VerdictStore | null };

/** Point the verdict endpoints at a specific store. Pass `null` to clear it. */
export function setVerdictStore(store: VerdictStore | null): void {
  installed.store = store;
}

/** As above, but from a raw executor — the usual form in a test. */
export function setVerdictDb(db: SqlExecutor | null): void {
  installed.store = db ? new SqlVerdictStore(db) : null;
}

/** The store for this request, or null when there is no database to write to. */
export function resolveVerdictStore(): VerdictStore | null {
  if (installed.store) return installed.store;
  if (!env.DATABASE_URL) return null;

  const cache = globalThis as unknown as { steamkidVerdictPool?: Pool };
  cache.steamkidVerdictPool ??= new Pool({ connectionString: env.DATABASE_URL });
  return new SqlVerdictStore(cache.steamkidVerdictPool);
}
