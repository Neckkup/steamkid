/**
 * Wiring: what the dashboard talks to at runtime.
 *
 * Mirrors `src/lib/events/runtime.ts` — a source installed by a test wins, a
 * `DATABASE_URL` builds the Postgres adapter, and nothing else exists. When
 * neither is available the answer is `null` and the screens say so out loud.
 * That is the whole reason this file is separate from `source.ts`: importing
 * the interface must not drag `pg` into a bundle, and a page must be able to
 * ask "is there a database?" without one being invented for it.
 */

import { Pool } from "pg";

import { pgConnectionOptions } from "@/lib/db/pg-connection";
import type { SqlExecutor } from "@/lib/db/sql";
import { env } from "@/lib/env";

import type { DemoGrowthDatabase } from "./dev-db";
import { getInstalledGrowthSource, setGrowthSource, type GrowthSource } from "./source";
import { SqlGrowthSource } from "./sql-source";

let override: SqlExecutor | null = null;

/** Point the dashboard at a specific database instead of `DATABASE_URL`. */
export function setGrowthDb(db: SqlExecutor | null): void {
  override = db;
  setGrowthSource(db ? new SqlGrowthSource(db) : null);
}

function growthDb(): SqlExecutor | null {
  if (override) return override;
  if (!env.DATABASE_URL) return null;

  const cache = globalThis as unknown as { steamkidGrowthPool?: Pool };
  cache.steamkidGrowthPool ??= new Pool(pgConnectionOptions(env.DATABASE_URL));
  return cache.steamkidGrowthPool;
}

/**
 * The source for this request, or null when there is no database to read.
 *
 * Async because the local demo database (`STEAMKID_DEV_DB=pglite`) has to apply
 * migrations before it can answer anything. In every deployed tier this
 * resolves synchronously on the first call and from the cache afterwards.
 *
 * The demo database is checked *before* `DATABASE_URL` on purpose. A checkout
 * usually carries a `DATABASE_URL` pointing at a Postgres nobody is running,
 * and preferring it meant `STEAMKID_DEV_DB=pglite` could never take effect
 * where it is needed most: every screen died on ECONNREFUSED instead. The flag
 * is an explicit request, it cannot be set in production (`devEnabled()`), and
 * everything it feeds carries the demo banner — so honouring it first costs
 * nothing a deployed tier can see.
 */
export async function resolveGrowthSource(): Promise<GrowthSource | null> {
  const installed = getInstalledGrowthSource();
  if (installed) return installed;

  const dev = await resolveDevSource();
  if (dev) {
    setGrowthSource(dev);
    return dev;
  }

  const db = growthDb();
  if (db) {
    const source = new SqlGrowthSource(db);
    setGrowthSource(source);
    return source;
  }

  return null;
}

/**
 * The opt-in local demo database.
 *
 * PRO-12 has not provisioned Postgres yet, so a developer or a reviewer looking
 * at this dashboard on `localhost` would otherwise only ever see the "no
 * database" state and could not check that the charts are right. Setting
 * `STEAMKID_DEV_DB=pglite` boots Postgres-in-WebAssembly, applies the real
 * migrations from `prisma/migrations/`, and seeds the same synthetic learners
 * the tests use — so what renders came out of the same SQL a deployment runs,
 * not out of a component with numbers typed into it.
 *
 * Two guards, because "demo data that looked real" is exactly the failure this
 * product cannot afford:
 *
 *   - it refuses to start in `production`, whatever the env var says
 *   - `isDemoDatabase()` is true while it is in use, and every screen renders a
 *     banner saying the numbers are synthetic
 */
/**
 * Held on `globalThis`, not in a module `let`.
 *
 * Next bundles pages and route handlers separately, so a module-scoped
 * singleton exists once *per bundle*: the page would build one PGlite and
 * `/api/verdicts/:id/override` would build a second, empty one, and a teacher's
 * correction would land in a database nothing renders from. The `pg.Pool` cache
 * below is on `globalThis` for the same reason.
 */
interface DemoCache {
  db?: Promise<DemoGrowthDatabase | null>;
  active?: boolean;
  learners?: readonly { publicRef: string; displayName: string }[];
  teacher?: string | null;
}

const demo = ((globalThis as unknown as { steamkidDemoDb?: DemoCache }).steamkidDemoDb ??=
  {}) as DemoCache;

function devEnabled(): boolean {
  return (
    process.env.STEAMKID_DEV_DB === "pglite" &&
    env.APP_ENV !== "production" &&
    env.NODE_ENV !== "production"
  );
}

/**
 * The one demo database, built at most once per process.
 *
 * Cached as the database rather than as a `GrowthSource` because the teacher
 * review screens (PRO-77) read `app.ai_verdict` out of the same rows. Two
 * PGlite instances would mean the roster and the review queue disagreed about
 * which children exist, which is worse than having no demo at all.
 */
async function resolveDevDb(): Promise<DemoGrowthDatabase | null> {
  if (!devEnabled()) return null;
  demo.db ??= (async () => {
    try {
      const { createDemoGrowthDatabase } = await import("./dev-db");
      const built = await createDemoGrowthDatabase();
      demo.learners = built.learners.map((learner) => ({
        publicRef: learner.publicRef,
        displayName: learner.displayName,
      }));
      demo.teacher = built.teacherUserId;
      demo.active = true;
      return built;
    } catch (error) {
      // A broken demo database must not take a page down. Fall back to the
      // honest "no data" state.
      console.warn("[growth] demo database unavailable:", String(error));
      return null;
    }
  })();
  return demo.db;
}

async function resolveDevSource(): Promise<GrowthSource | null> {
  const built = await resolveDevDb();
  return built ? new SqlGrowthSource(built.db) : null;
}

/** The demo database's executor, for readers that are not the growth source. */
export async function resolveDemoDb(): Promise<SqlExecutor | null> {
  return (await resolveDevDb())?.db ?? null;
}

/**
 * The seeded teacher account, so the demo can hold a `sk_teacher` cookie.
 *
 * Null outside demo mode — there is no such thing as a teacher id to hand out
 * when the rows are real.
 */
export function demoTeacherUserId(): string | null {
  return demo.active ? (demo.teacher ?? null) : null;
}

/** True when the rows on screen came from the local demo database. */
export function isDemoDatabase(): boolean {
  return demo.active === true;
}

/**
 * Which learner the child's screen should show while the demo database is on.
 *
 * A real child is identified by the `sk_learner` cookie, which in a checkout
 * without Postgres matches no row — correctly, because that child has no
 * snapshots. The demo database exists precisely so the populated screen can be
 * looked at, so in demo mode the cookie is swapped for a seeded learner.
 * Returns null whenever the demo database is not in use, and this function is
 * the only place that substitution can happen.
 */
export function demoLearnerRef(index = 0): string | null {
  if (!demo.active) return null;
  return demo.learners?.[index]?.publicRef ?? null;
}

export function demoLearnerRefs(): readonly { publicRef: string; displayName: string }[] {
  return demo.active ? (demo.learners ?? []) : [];
}
