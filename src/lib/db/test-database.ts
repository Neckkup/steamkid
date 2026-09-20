/**
 * A throwaway Postgres, built from the migrations we actually ship.
 *
 * `@electric-sql/pglite` is Postgres 17 compiled to WebAssembly, so it runs
 * partitioned tables, plpgsql triggers, `citext` and `CHECK` constraints — all
 * the things the behaviour pipe leans on and a mocked client would quietly not
 * enforce. Building the fixture from `prisma/migrations/` rather than from a
 * hand-written schema is the point: a test can only pass against the schema
 * a deploy would produce, and a migration that does not apply cleanly fails
 * the suite instead of failing the release.
 *
 * Test-only. Nothing in `src/app` imports this, and PGlite is a devDependency.
 */

import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

import { loadMigrations } from "./migrations";
import type { SqlExecutor, SqlResult } from "./sql";

export interface TestDatabase extends SqlExecutor {
  readonly pg: PGlite;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const pg = await PGlite.create({ extensions: { citext, pgcrypto } });

  for (const migration of loadMigrations()) {
    try {
      await pg.exec(migration.up);
    } catch (error) {
      throw new Error(`migration ${migration.name} failed to apply: ${String(error)}`);
    }
  }

  return {
    pg,
    async query<Row = Record<string, unknown>>(
      text: string,
      params: readonly unknown[] = [],
    ): Promise<SqlResult<Row>> {
      const result = await pg.query<Row>(text, params as unknown[]);
      return { rows: result.rows };
    },
    async exec(sql: string): Promise<void> {
      await pg.exec(sql);
    },
    async close(): Promise<void> {
      await pg.close();
    },
  };
}
