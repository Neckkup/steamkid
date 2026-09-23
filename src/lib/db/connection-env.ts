/**
 * Which environment variable carries which Postgres role (PRO-103).
 *
 * The split is `steamkid_migrate` (DDL) and `steamkid_runtime` (DML only). Both
 * arrive by secret injection, and the injected names are **not** `DIRECT_URL`
 * and `DATABASE_URL`: those two paths were already bound to the combined
 * `steamkid_app` credential, and Paperclip refuses to overwrite an occupied
 * config path (`http_409`). A binding can be added, never replaced in place.
 *
 * Rather than leave the roles unbound, the split roles get their own names:
 *
 *   MIGRATE_DATABASE_URL  session mode (5432), role `steamkid_migrate`
 *   RUNTIME_DATABASE_URL  transaction pooler (6543), role `steamkid_runtime`
 *
 * The old names keep working as a fallback, which is what lets a plain local
 * checkout, CI, and a bare `docker run postgres` stay on a single URL with no
 * Paperclip vault in sight.
 *
 * **The new name wins when both are set, and that ordering is the whole point.**
 * After the cutover the runner still injects `DATABASE_URL`/`DIRECT_URL`
 * pointing at the retiring `steamkid_app`; those values must lose, or the role
 * split would be undone by an environment variable nobody remembered was there.
 *
 * `resolve()` returns the *name* it read alongside the value so a caller can say
 * which variable it used. `verify:roles` prints it and then asserts the role the
 * server reports — a silent fallback to the retiring credential is exactly the
 * failure this file has to make loud, and provenance plus `current_user` is what
 * makes it loud.
 */

/** Names that may carry the migrator (DDL) URL, most specific first. */
export const MIGRATE_URL_NAMES = ["MIGRATE_DATABASE_URL", "DIRECT_URL"] as const;

/** Names that may carry the runtime (DML) URL, most specific first. */
export const RUNTIME_URL_NAMES = ["RUNTIME_DATABASE_URL", "DATABASE_URL"] as const;

export type ConnectionUrlName =
  | (typeof MIGRATE_URL_NAMES)[number]
  | (typeof RUNTIME_URL_NAMES)[number];

/** A connection URL plus the environment variable it came from. */
export type ResolvedConnectionUrl = {
  /** The variable that supplied the value. Report this; do not report the URL. */
  name: ConnectionUrlName;
  url: string;
};

type EnvSource = Record<string, string | undefined>;

/**
 * First non-blank value among `names`.
 *
 * Blank is treated as unset for the same reason `src/lib/env.ts` does it:
 * hosting platforms define a variable as `""` rather than leaving it out, and an
 * empty string here would shadow a perfectly good fallback.
 */
export function resolveConnectionUrl(
  source: EnvSource,
  names: readonly ConnectionUrlName[],
): ResolvedConnectionUrl | undefined {
  for (const name of names) {
    const url = source[name]?.trim();
    if (url) return { name, url };
  }
  return undefined;
}

/** The DDL credential: `MIGRATE_DATABASE_URL`, else `DIRECT_URL`. */
export function resolveMigrateUrl(source: EnvSource): ResolvedConnectionUrl | undefined {
  return resolveConnectionUrl(source, MIGRATE_URL_NAMES);
}

/** The application credential: `RUNTIME_DATABASE_URL`, else `DATABASE_URL`. */
export function resolveRuntimeUrl(source: EnvSource): ResolvedConnectionUrl | undefined {
  return resolveConnectionUrl(source, RUNTIME_URL_NAMES);
}

/** Human-readable "either of these two names", for error messages. */
export function describeNames(names: readonly ConnectionUrlName[]): string {
  return names.join(" or ");
}
