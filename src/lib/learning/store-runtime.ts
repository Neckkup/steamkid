/**
 * Wiring: which LearningStore the app talks to at runtime (PRO-169).
 *
 * Same pattern as verdict-runtime.ts and events/runtime.ts:
 *   - the Pool is cached on globalThis so hot-reload doesn't leak connections
 *   - the store is installed via setLearningStore(), not by patching getLearningStore()
 *   - this module is the only one that imports `pg` on behalf of the store
 *
 * Called once from src/instrumentation.ts before the first request is handled.
 * Tests call setLearningStore() directly and never touch this module.
 */

import { Pool } from "pg";

import { pgConnectionOptions } from "@/lib/db/pg-connection";
import { resolveRuntimeUrl } from "@/lib/db/connection-env";

import { PostgresLearningStore } from "./pg-store";
import { setLearningStore } from "./store";

/**
 * Install a PostgresLearningStore if RUNTIME_DATABASE_URL (or DATABASE_URL)
 * is available. Safe to call multiple times — subsequent calls are no-ops.
 *
 * When no URL is found, the MemoryLearningStore from getLearningStore() stays
 * in place. That is the correct behaviour for local dev without a database.
 */
export function initLearningStore(): void {
  const resolved = resolveRuntimeUrl(process.env as Record<string, string | undefined>);
  if (!resolved) return;

  const cache = globalThis as unknown as { steamkidLearningPool?: Pool };
  cache.steamkidLearningPool ??= new Pool(pgConnectionOptions(resolved.url));

  setLearningStore(new PostgresLearningStore(cache.steamkidLearningPool));
}
