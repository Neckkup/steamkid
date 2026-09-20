/**
 * Reading `prisma/migrations/` as data.
 *
 * Two callers need it and neither is `prisma migrate deploy`:
 *
 *   - `pg-sink.test.ts` builds a throwaway database from the real migration
 *     files, so a test can only pass against the schema we actually ship
 *   - `ml-views.test.ts` reads the SQL text to enforce data-schema §6's rule
 *     that no view in `ml` may mention `identity.` or select `learner.id`
 *
 * Node-only: this imports `fs`. Nothing in `src/app` may import it.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const MIGRATIONS_DIR = join(process.cwd(), "prisma", "migrations");

export interface Migration {
  /** Directory name, e.g. `20260919000100_identity_app_consent`. */
  readonly name: string;
  readonly up: string;
  /**
   * The reverse script. Every migration in this repo has one — PRO-7's
   * operating rule is that a migration is either reversible or ships with a
   * written forward fix, and "reversible" has to mean a file somebody can run.
   */
  readonly down: string;
}

/** Migrations in the order Prisma would apply them: lexicographic by name. */
export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({
      name,
      up: readFileSync(join(dir, name, "migration.sql"), "utf8"),
      down: readFileSync(join(dir, name, "down.sql"), "utf8"),
    }));
}
