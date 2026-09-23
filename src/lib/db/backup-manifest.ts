/**
 * Running `scripts/sql/backup-manifest.sql` from Node.
 *
 * The manifest is the fingerprint a restore is checked against: one file, run on
 * the source at dump time and on the restored instance afterwards, and the two
 * outputs must be identical (`docs/runbooks/postgres-backup-restore.md` §5.2).
 * The runbook's own command pipes it through `psql -At -F','`.
 *
 * This module produces the *same text* without `psql`, for two reasons:
 *
 *   - a Paperclip runner has no `psql` installed (verified), so a check that
 *     needs the binary cannot run in the suite, and a fingerprint nobody can
 *     execute is a fingerprint nobody knows is broken;
 *   - `pg` is already a dependency, so the day the drill runs for real the same
 *     function can produce the source-side manifest from a script.
 *
 * Keeping the SQL in the `.sql` file and only the *formatting* here is the point.
 * Two copies of the checks would drift, and then the two sides of a restore
 * comparison would be comparing different questions.
 *
 * Node-only: this reads the filesystem. Nothing in `src/app` may import it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { SqlExecutor } from "./sql";

export const MANIFEST_SQL_PATH = join(process.cwd(), "scripts", "sql", "backup-manifest.sql");

/** One `section,key,value` row of the manifest, as `psql -At -F','` prints it. */
export type ManifestLine = string;

/**
 * The manifest's queries, in file order.
 *
 * `psql` meta-commands (`\pset`) are dropped: they configure psql's output and
 * are not SQL. Comment-only lines go too, so a comment containing a semicolon
 * can never split a statement.
 */
export function loadManifestStatements(path: string = MANIFEST_SQL_PATH): string[] {
  const sql = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("\\") && !line.trimStart().startsWith("--"))
    .join("\n");

  return sql
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/**
 * Run the manifest and return its lines.
 *
 * Faithful to `-At -F','`: unaligned, no header, no row count, fields joined by
 * a comma, NULL as the empty string. Columns are read by name rather than by
 * object key order, because the comparison is only meaningful if both sides
 * serialise the same way every time.
 */
export async function runBackupManifest(
  sql: SqlExecutor,
  path: string = MANIFEST_SQL_PATH,
): Promise<ManifestLine[]> {
  const lines: ManifestLine[] = [];

  for (const statement of loadManifestStatements(path)) {
    const { rows } = await sql.query<{
      section: string | null;
      key: string | null;
      value: string | null;
    }>(statement);

    for (const row of rows) {
      lines.push([row.section, row.key, row.value].map((field) => field ?? "").join(","));
    }
  }

  return lines;
}

/** The manifest as a file would hold it, so a drill can `diff` two of them. */
export function formatManifest(lines: readonly ManifestLine[]): string {
  return `${lines.join("\n")}\n`;
}

/** The single value of one manifest line, e.g. `rowcount` / `app.learner`. */
export function manifestValue(
  lines: readonly ManifestLine[],
  section: string,
  key: string,
): string | undefined {
  const prefix = `${section},${key},`;
  const found = lines.find((line) => line.startsWith(prefix));
  return found?.slice(prefix.length);
}
