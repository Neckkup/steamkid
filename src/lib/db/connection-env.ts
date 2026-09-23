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
 *
 * Since 2026-09-23 `steamkid_app` no longer exists in Postgres, so resolving a
 * URL that names it is refused here rather than left to the server. See
 * `assertUsableRole` for why that refusal is worth the code.
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
 * The combined DDL+DML role from PRO-70, dropped from Postgres on 2026-09-23.
 *
 * Supabase's pooler wants `role.project_ref` as the username, so the role name
 * is a prefix of what appears in the URL rather than the whole of it.
 */
export const RETIRED_ROLE = "steamkid_app";

/** The role a connection URL authenticates as, or undefined if unreadable. */
export function connectionRole(url: string): string | undefined {
  let username: string;
  try {
    username = decodeURIComponent(new URL(url).username);
  } catch {
    // A libpq keyword string, a socket path, or anything else `URL` rejects.
    // Not knowing the role is not a reason to refuse the connection; the server
    // still gets the last word.
    return undefined;
  }
  if (!username) return undefined;
  // `steamkid_runtime.abujf…` -> `steamkid_runtime`.
  const [role] = username.split(".");
  return role || undefined;
}

/**
 * Refuse a URL that authenticates as the retired role.
 *
 * The old `DATABASE_URL` / `DIRECT_URL` bindings still inject the `steamkid_app`
 * credential into agent environments, and no agent-facing route can delete a
 * binding — only the board can. The new names win in `resolve()`, so nothing
 * reads these values while both are present; the hazard is the machine that has
 * only the old one, where the first symptom would be a SCRAM failure against a
 * role name that no longer appears anywhere in the catalog.
 *
 * Failing here instead turns that into the one sentence that fixes it. This is
 * the mitigation that let the `DROP ROLE` proceed without waiting on a manual
 * binding cleanup: the leftover injection is now inert *and* self-explanatory.
 */
export function assertUsableRole(resolved: ResolvedConnectionUrl): ResolvedConnectionUrl {
  if (connectionRole(resolved.url) !== RETIRED_ROLE) return resolved;
  throw new Error(
    `${resolved.name} still carries the retired \`${RETIRED_ROLE}\` credential, ` +
      `which was dropped from Postgres on 2026-09-23 (PRO-103). Connecting with ` +
      `it fails authentication against a role that no longer exists. Use ` +
      `${describeNames(MIGRATE_URL_NAMES)} for DDL and ` +
      `${describeNames(RUNTIME_URL_NAMES)} for application queries; the split ` +
      `roles are \`steamkid_migrate\` and \`steamkid_runtime\`.`,
  );
}

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
    if (url) return assertUsableRole({ name, url });
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
