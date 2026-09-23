/**
 * A local Postgres for looking at this dashboard before PRO-12 provisions one.
 *
 * Loaded only through the dynamic import in `runtime.ts`, only when
 * `STEAMKID_DEV_DB=pglite`, and never in production. It applies the real
 * migrations from `prisma/migrations/` and seeds the synthetic learners from
 * `fixtures.ts`, so the page renders rows that came out of the same SQL a
 * deployment runs — a chart drawn from `app.skill_state_history` rather than
 * from numbers typed into a component.
 *
 * Why this exists at all: the alternative was a hardcoded sample object behind
 * a flag, and a hardcoded sample object is the exact thing the PRO-9 acceptance
 * criteria rule out. This keeps the app with one data path.
 *
 * It is a development aid and it is not durable — the database lives in memory
 * and starts empty on every restart.
 */

import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

import { loadMigrations } from "@/lib/db/migrations";
import type { SqlExecutor, SqlResult } from "@/lib/db/sql";
import { seedReviewDemo } from "@/lib/learning/review-fixtures";

import { seedGrowthDemo, type SeededGrowthLearner } from "./fixtures";

export interface DemoGrowthDatabase {
  readonly db: SqlExecutor;
  /** The seeded learners, so the dev screens know which refs exist. */
  readonly learners: readonly SeededGrowthLearner[];
  /**
   * The seeded teacher account (PRO-77). The review screens need a real
   * `identity.user_account` row with role `teacher`, because the correction
   * table's composite foreign key will not accept anything else.
   */
  readonly teacherUserId: string;
  /** One verdict per status: unscorable, blocked_by_safety, graded. */
  readonly verdictIds: readonly string[];
}

export async function createDemoGrowthDatabase(): Promise<DemoGrowthDatabase> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("the demo growth database must never run in production");
  }

  const pg = await PGlite.create({ extensions: { citext, pgcrypto } });
  for (const migration of loadMigrations()) {
    await pg.exec(migration.up);
  }

  const executor: SqlExecutor = {
    async query<Row = Record<string, unknown>>(
      text: string,
      params: readonly unknown[] = [],
    ): Promise<SqlResult<Row>> {
      const result = await pg.query<Row>(text, params as unknown[]);
      return { rows: result.rows };
    },
  };

  const learners = await seedGrowthDemo(executor);

  // The AI verdicts hang off the learner who already has a full growth
  // picture, so a reviewer can walk from the roster to a verdict and back.
  const first = learners[0];
  if (!first) throw new Error("the demo growth database seeded no learners");
  const review = await seedReviewDemo(executor, first.learnerId);

  return {
    db: executor,
    learners,
    teacherUserId: review.teacherUserId,
    verdictIds: review.verdictIds,
  };
}
