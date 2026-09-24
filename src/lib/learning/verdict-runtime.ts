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

import { pgConnectionOptions } from "@/lib/db/pg-connection";
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
const installed = ((
  globalThis as unknown as {
    steamkidVerdictStore?: { store?: VerdictStore | null; db?: SqlExecutor | null };
  }
).steamkidVerdictStore ??= {}) as { store?: VerdictStore | null; db?: SqlExecutor | null };

/** Point the verdict endpoints at a specific store. Pass `null` to clear it. */
export function setVerdictStore(store: VerdictStore | null): void {
  installed.store = store;
}

/** As above, but from a raw executor — the usual form in a test. */
export function setVerdictDb(db: SqlExecutor | null): void {
  installed.db = db;
  installed.store = db ? new SqlVerdictStore(db) : null;
}

/**
 * The executor behind the store, or null when there is no database.
 *
 * Exists because storing a verdict needs one thing the `VerdictStore`
 * interface deliberately does not carry: `app.learner.id`. The grading path
 * only ever sees the cookie's `public_ref`, and exchanging one for the other is
 * a query (`resolveLearnerId`), not a method on a write interface. Widening
 * `VerdictStore` with a learner lookup would put an identity concern inside the
 * thing whose whole contract is "write a verdict, nothing else".
 *
 * `setVerdictStore()` alone therefore leaves this null on purpose: a test that
 * installs a hand-rolled store has no database to resolve a learner against,
 * and inventing `DATABASE_URL` underneath it would be a surprise.
 */
export function resolveVerdictDb(): SqlExecutor | null {
  if (installed.db) return installed.db;
  if (installed.store) return null;
  if (!env.DATABASE_URL) return null;
  return verdictPool();
}

/** The store for this request, or null when there is no database to write to. */
export function resolveVerdictStore(): VerdictStore | null {
  if (installed.store) return installed.store;
  if (!env.DATABASE_URL) return null;
  return new SqlVerdictStore(verdictPool());
}

function verdictPool(): Pool {
  const cache = globalThis as unknown as { steamkidVerdictPool?: Pool };
  cache.steamkidVerdictPool ??= new Pool(pgConnectionOptions(env.DATABASE_URL as string));
  return cache.steamkidVerdictPool;
}
