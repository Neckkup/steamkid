/**
 * Assert the privilege model against every object that actually exists.
 *
 * `npm run verify:grants`
 *
 * `verify:roles` is the sharper check but it has two limits, and on
 * 2026-09-23 both of them mattered at once.
 *
 * It needs *both* new credentials, so between raising a secret proposal and the
 * board approving it there is a window where nobody on the team can check the
 * split at all. And it proves its point with a single fixture table in
 * `events`, so it says nothing about the tables a migration already created,
 * nothing about `identity` or `app`, and — the one that would have cost us —
 * nothing about `ml` being read-only, which is the control that stops
 * application code writing to the consent-filtered training projection.
 *
 * What went wrong in that window is the reason this file exists. The PRO-68
 * migrations were applied as `steamkid_app` after a schema reset that took back
 * ownership of the four schemas. `ALTER DEFAULT PRIVILEGES` only ever applies
 * to objects created afterwards by the role named in `FOR ROLE`, so all 31 new
 * tables landed outside it: `steamkid_runtime` held no privilege on any of
 * them. Nothing looked wrong. Both roles existed, and `pg_default_acl` still
 * read exactly as designed.
 *
 * So this check reads the catalog instead of probing behaviour. It needs one
 * connection with no special rights, it covers every table rather than a
 * sample, and it fails on the state above.
 */

import { Client } from "pg";

import {
  resolveMigrateUrl,
  resolveRuntimeUrl,
  type ResolvedConnectionUrl,
} from "../src/lib/db/connection-env";

/** The schemas the application owns. `ml` is deliberately not like the others. */
const WRITABLE_SCHEMAS = ["identity", "app", "events"] as const;
const READ_ONLY_SCHEMAS = ["ml"] as const;
const ALL_SCHEMAS = [...WRITABLE_SCHEMAS, ...READ_ONLY_SCHEMAS] as const;

const RUNTIME = "steamkid_runtime";
const MIGRATE = "steamkid_migrate";

const WRITE_PRIVILEGES = ["INSERT", "UPDATE", "DELETE"] as const;

type Result = { readonly name: string; readonly passed: boolean; readonly detail: string };

const results: Result[] = [];

function check(name: string, passed: boolean, detail: string): void {
  results.push({ name, passed, detail });
}

/**
 * Prefer the migrator URL but accept either.
 *
 * The point of a catalog check is that it runs with whatever credential the
 * caller happens to hold — including `steamkid_app` before the cutover, which
 * is the only one available while the new secrets sit in the approval queue.
 * Privilege lookups in `pg_catalog` are readable by any role that can connect.
 */
function connection(): ResolvedConnectionUrl {
  const resolved = resolveMigrateUrl(process.env) ?? resolveRuntimeUrl(process.env);
  if (!resolved) {
    throw new Error(
      "No Postgres URL is set (MIGRATE_DATABASE_URL, DIRECT_URL, " +
        "RUNTIME_DATABASE_URL or DATABASE_URL). They come from the Paperclip vault; " +
        "see ADR 0005.",
    );
  }
  // pg 8.23 reads `sslmode=require` as `verify-full`, which Supabase's pooler
  // chain fails with a self-signed-certificate error that reads like an outage.
  // ADR 0005 carries the CA-pinning follow-up; this keeps the check runnable.
  const url = resolved.url.includes("uselibpqcompat")
    ? resolved.url
    : `${resolved.url}&uselibpqcompat=true`;
  return { name: resolved.name, url };
}

async function main(): Promise<void> {
  const source = connection();
  console.log(`read via ${source.name}\n`);
  const client = new Client({ connectionString: source.url });
  await client.connect();

  try {
    const who = await client.query<{ current_user: string }>("SELECT current_user");
    console.log(`connected as ${who.rows[0].current_user}\n`);

    // ---------------------------------------------------------------------
    // 1. The roles exist and carry no authority beyond logging in.
    // ---------------------------------------------------------------------
    const roles = await client.query<{
      rolname: string;
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolcreaterole: boolean;
      rolcreatedb: boolean;
      rolreplication: boolean;
      rolbypassrls: boolean;
    }>(
      `SELECT rolname, rolcanlogin, rolsuper, rolcreaterole, rolcreatedb,
              rolreplication, rolbypassrls
         FROM pg_roles WHERE rolname = ANY($1)`,
      [[RUNTIME, MIGRATE]],
    );

    for (const name of [RUNTIME, MIGRATE]) {
      const role = roles.rows.find((r) => r.rolname === name);
      if (!role) {
        check(`${name} exists`, false, "no such role");
        continue;
      }
      check(`${name} exists and can log in`, role.rolcanlogin, "LOGIN");
      // `rolbypassrls` is in here because row-level security is how a child's
      // rows will eventually be fenced off from one another. A role that can
      // bypass it makes that fence decorative.
      const extra = (["rolsuper", "rolcreaterole", "rolcreatedb", "rolreplication", "rolbypassrls"] as const)
        .filter((attribute) => role[attribute]);
      check(
        `${name} holds no elevated role attribute`,
        extra.length === 0,
        extra.length === 0 ? "none" : `unexpected: ${extra.join(", ")}`,
      );
    }

    // ---------------------------------------------------------------------
    // 2. Database level. The single most load-bearing grant in the model:
    //    with CREATE on the database, "no DDL" is decoration, because the
    //    runtime role can build a schema it owns and do as it likes inside.
    // ---------------------------------------------------------------------
    const database = await client.query<{ conn: boolean; create: boolean }>(
      `SELECT has_database_privilege($1, current_database(), 'CONNECT') AS conn,
              has_database_privilege($1, current_database(), 'CREATE')  AS create`,
      [RUNTIME],
    );
    check(`${RUNTIME} may connect`, database.rows[0].conn, "CONNECT");
    check(
      `${RUNTIME} has no CREATE on the database`,
      !database.rows[0].create,
      database.rows[0].create ? "HOLDS CREATE — it can create a schema it owns" : "revoked",
    );

    // ---------------------------------------------------------------------
    // 3. Schema level, including `public`: citext and _prisma_migrations live
    //    there, and it is the default landing place for anything unqualified.
    // ---------------------------------------------------------------------
    const schemas = await client.query<{ nspname: string; usage: boolean; create: boolean }>(
      `SELECT n.nspname,
              has_schema_privilege($2, n.nspname, 'USAGE')  AS usage,
              has_schema_privilege($2, n.nspname, 'CREATE') AS create
         FROM pg_namespace n WHERE n.nspname = ANY($1)`,
      [[...ALL_SCHEMAS, "public"], RUNTIME],
    );
    for (const schema of schemas.rows) {
      if (schema.nspname !== "public") {
        check(`${RUNTIME} may use ${schema.nspname}`, schema.usage, "USAGE");
      }
      check(
        `${RUNTIME} cannot create in ${schema.nspname}`,
        !schema.create,
        schema.create ? "HOLDS CREATE" : "revoked",
      );
    }
    check(
      "all four application schemas exist",
      ALL_SCHEMAS.every((s) => schemas.rows.some((r) => r.nspname === s)),
      schemas.rows.map((r) => r.nspname).join(", "),
    );

    // ---------------------------------------------------------------------
    // 4. Ownership. This is the whole append-only guarantee in one query.
    //    DROP TABLE, ALTER TABLE and DROP TRIGGER all require ownership and
    //    cannot be granted, so a runtime role that owns nothing cannot reshape
    //    anything or remove the triggers protecting a child's history —
    //    whoever the owner happens to be.
    // ---------------------------------------------------------------------
    const owned = await client.query<{ kind: string; name: string }>(
      `SELECT 'table' AS kind, format('%I.%I', n.nspname, c.relname) AS name
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relowner = $1::regrole AND n.nspname = ANY($2)
        UNION ALL
       SELECT 'schema', nspname FROM pg_namespace
        WHERE nspowner = $1::regrole AND nspname = ANY($2)`,
      [RUNTIME, [...ALL_SCHEMAS, "public"]],
    );
    check(
      `${RUNTIME} owns nothing`,
      owned.rows.length === 0,
      owned.rows.length === 0
        ? "no tables, no schemas — DROP/ALTER/DROP TRIGGER are unreachable"
        : `owns ${owned.rows.length}: ${owned.rows.map((r) => `${r.kind} ${r.name}`).join(", ")}`,
    );

    // ---------------------------------------------------------------------
    // 4b. The other half of ownership: everything belongs to the migrator.
    //
    //    Section 4 asks whether the runtime role owns anything, which is the
    //    security question. This asks whether anybody *else* does, which is
    //    the operational one, and on 2026-09-23 it was the expensive one: the
    //    09:17 reset left all 31 tables and all four schemas owned by
    //    `steamkid_app`, so `ALTER DEFAULT PRIVILEGES FOR ROLE
    //    steamkid_migrate` covered nothing that existed and nothing that was
    //    about to be created. Section 6 notices the consequence per schema;
    //    this names the cause directly, and keeps naming it after
    //    `steamkid_app` is dropped and the story is no longer fresh.
    //
    //    Prisma's ledger is in here because `prisma migrate` alters it during
    //    some upgrades, and ALTER needs ownership rather than the DML grant
    //    section 4c hands out.
    // ---------------------------------------------------------------------
    const foreignOwned = await client.query<{ kind: string; name: string; owner: string }>(
      `SELECT CASE c.relkind WHEN 'v' THEN 'view' WHEN 'S' THEN 'sequence' ELSE 'table' END AS kind,
              format('%I.%I', n.nspname, c.relname) AS name,
              pg_get_userbyid(c.relowner) AS owner
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ANY($2) AND c.relkind IN ('r', 'p', 'v', 'S')
          AND c.relowner <> $1::regrole
        UNION ALL
       SELECT 'schema', nspname, pg_get_userbyid(nspowner) FROM pg_namespace
        WHERE nspname = ANY($2) AND nspowner <> $1::regrole
        UNION ALL
       SELECT 'ledger', 'public._prisma_migrations', pg_get_userbyid(relowner)
         FROM pg_class WHERE oid = 'public._prisma_migrations'::regclass
          AND relowner <> $1::regrole`,
      [MIGRATE, ALL_SCHEMAS],
    );
    const strayOwners = [...new Set(foreignOwned.rows.map((r) => r.owner))];
    check(
      `${MIGRATE} owns every object in the application schemas`,
      foreignOwned.rows.length === 0,
      foreignOwned.rows.length === 0
        ? "schemas, tables, views, sequences and Prisma's ledger"
        : `${foreignOwned.rows.length} owned by ${strayOwners.join(", ")}: ` +
          `${foreignOwned.rows
            .slice(0, 5)
            .map((r) => `${r.kind} ${r.name}`)
            .join(", ")}${foreignOwned.rows.length > 5 ? ", …" : ""}` +
          ` — ALTER DEFAULT PRIVILEGES FOR ROLE ${MIGRATE} does not reach what they create`,
    );

    // ---------------------------------------------------------------------
    // 5. Every table that exists, not a sample. This is the check that catches
    //    a migration applied by an unexpected role: default privileges stay
    //    perfectly intact while the tables they were meant to cover do not
    //    exist yet, or were created by someone the defaults do not name.
    // ---------------------------------------------------------------------
    const tables = await client.query<{
      schemaname: string;
      tablename: string;
      can_select: boolean;
      can_insert: boolean;
      can_update: boolean;
      can_delete: boolean;
    }>(
      `SELECT t.schemaname, t.tablename,
              has_table_privilege($2, q.rel, 'SELECT') AS can_select,
              has_table_privilege($2, q.rel, 'INSERT') AS can_insert,
              has_table_privilege($2, q.rel, 'UPDATE') AS can_update,
              has_table_privilege($2, q.rel, 'DELETE') AS can_delete
         FROM pg_tables t
        CROSS JOIN LATERAL (SELECT format('%I.%I', t.schemaname, t.tablename) AS rel) q
        WHERE t.schemaname = ANY($1)
        ORDER BY t.schemaname, t.tablename`,
      [ALL_SCHEMAS, RUNTIME],
    );

    // An empty database would otherwise make every per-table loop below pass
    // by having nothing to iterate. That is the failure this file was written
    // after, in mirror image, so it is worth being explicit about.
    check(
      "there are tables to check",
      tables.rows.length > 0,
      `${tables.rows.length} table(s) across ${ALL_SCHEMAS.join(", ")}`,
    );

    for (const schema of WRITABLE_SCHEMAS) {
      const inSchema = tables.rows.filter((t) => t.schemaname === schema);
      const missing = inSchema.filter(
        (t) => !(t.can_select && t.can_insert && t.can_update && t.can_delete),
      );
      check(
        `${RUNTIME} has full DML on all ${inSchema.length} table(s) in ${schema}`,
        inSchema.length > 0 && missing.length === 0,
        missing.length === 0
          ? "SELECT, INSERT, UPDATE, DELETE"
          : `${missing.length} without it: ${missing.map((t) => t.tablename).join(", ")}`,
      );
    }

    for (const schema of READ_ONLY_SCHEMAS) {
      const inSchema = tables.rows.filter((t) => t.schemaname === schema);
      const unreadable = inSchema.filter((t) => !t.can_select);
      const writable = inSchema.filter((t) => t.can_insert || t.can_update || t.can_delete);
      check(
        `${RUNTIME} can read all ${inSchema.length} table(s) in ${schema}`,
        inSchema.length > 0 && unreadable.length === 0,
        unreadable.length === 0 ? "SELECT" : `cannot read: ${unreadable.map((t) => t.tablename).join(", ")}`,
      );
      // The training projection is consent-filtered. Application code has no
      // legitimate reason to write to it, so it does not get the option.
      check(
        `${RUNTIME} cannot write to ${schema}`,
        writable.length === 0,
        writable.length === 0
          ? "no INSERT, UPDATE or DELETE"
          : `WRITABLE: ${writable.map((t) => t.tablename).join(", ")}`,
      );
    }

    // ---------------------------------------------------------------------
    // 6. The next migration. Section 5 covers what exists; this covers what
    //    has not been created yet, for every role that currently owns objects
    //    in these schemas — which is the bit that silently rots when a
    //    migration is applied by a role the defaults were not written for.
    // ---------------------------------------------------------------------
    const owners = await client.query<{ schemaname: string; owner: string }>(
      `SELECT DISTINCT t.schemaname, t.tableowner AS owner
         FROM pg_tables t WHERE t.schemaname = ANY($1)`,
      [ALL_SCHEMAS],
    );

    const defaults = await client.query<{ nspname: string; owner: string; privs: string[] }>(
      `SELECT n.nspname, pg_get_userbyid(d.defaclrole) AS owner,
              array_agg(g.privilege_type) AS privs
         FROM pg_default_acl d
         JOIN pg_namespace n ON n.oid = d.defaclnamespace
        CROSS JOIN LATERAL aclexplode(d.defaclacl) g
        WHERE d.defaclobjtype = 'r' AND g.grantee = $1::regrole
        GROUP BY 1, 2`,
      [RUNTIME],
    );

    for (const { schemaname, owner } of owners.rows) {
      const entry = defaults.rows.find((d) => d.nspname === schemaname && d.owner === owner);
      const privs = entry?.privs ?? [];
      const readOnly = (READ_ONLY_SCHEMAS as readonly string[]).includes(schemaname);
      const required = readOnly ? ["SELECT"] : ["SELECT", ...WRITE_PRIVILEGES];
      const absent = required.filter((p) => !privs.includes(p));
      check(
        `a new table created by ${owner} in ${schemaname} reaches ${RUNTIME}`,
        absent.length === 0,
        absent.length === 0
          ? privs.slice().sort().join(", ")
          : `missing ${absent.join(", ")} — the next migration by ${owner} lands unreachable`,
      );
      if (readOnly) {
        const granted = WRITE_PRIVILEGES.filter((p) => privs.includes(p));
        check(
          `a new table created by ${owner} in ${schemaname} stays read-only`,
          granted.length === 0,
          granted.length === 0 ? "no write default" : `WRITABLE by default: ${granted.join(", ")}`,
        );
      }
    }

    // ---------------------------------------------------------------------
    // 7. The migrator can actually migrate.
    //
    //    Section 6 asks where a new table *lands*. It never asks whether the
    //    migrator can create one at all, and on 2026-09-23 the answer was no:
    //    the 09:17 reset gave the four schemas back to `steamkid_app`, and
    //    section 3 only ever grants the migrator CREATE implicitly, by owning
    //    them. `CREATE SCHEMA IF NOT EXISTS ... AUTHORIZATION` is a no-op once
    //    the schema exists, so re-running roles.sql did not put it back.
    //
    //    `steamkid_migrate` kept CREATE on the database, which is why nothing
    //    looked wrong, while `CREATE TABLE app.x` returned 42501. That is the
    //    first statement of the next `prisma migrate deploy`, and the cutover
    //    hands Backend this credential before it reassigns ownership.
    // ---------------------------------------------------------------------
    const migrateCreate = await client.query<{ schema: string; can_create: boolean }>(
      `SELECT s AS schema, has_schema_privilege($1, s, 'CREATE') AS can_create
         FROM unnest($2::text[]) s`,
      [MIGRATE, ALL_SCHEMAS],
    );
    for (const { schema, can_create } of migrateCreate.rows) {
      check(
        `${MIGRATE} can create in ${schema}`,
        can_create,
        can_create
          ? "CREATE"
          : "42501 on the next migration — CREATE on the database is not enough",
      );
    }

    // Prisma reads `public._prisma_migrations` before it does anything else,
    // including in `migrate status`. The migrator held nothing on it — the
    // cutover's own verification step would have been the thing that failed.
    // The runtime role must never reach it: application code has no business
    // reading or rewriting migration history.
    const ledger = await client.query<{ role: string; privs: string[] | null }>(
      `SELECT r AS role,
              array_remove(array_agg(p ORDER BY p) FILTER (
                WHERE has_table_privilege(r, 'public._prisma_migrations', p)), NULL) AS privs
         FROM unnest(ARRAY[$1::text, $2::text]) r
         CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p
        GROUP BY r`,
      [MIGRATE, RUNTIME],
    );
    const migrateLedger = ledger.rows.find((l) => l.role === MIGRATE)?.privs ?? [];
    const runtimeLedger = ledger.rows.find((l) => l.role === RUNTIME)?.privs ?? [];
    const ledgerMissing = ["SELECT", ...WRITE_PRIVILEGES].filter(
      (p) => !migrateLedger.includes(p),
    );
    check(
      `${MIGRATE} can use Prisma's migration ledger`,
      ledgerMissing.length === 0,
      ledgerMissing.length === 0
        ? migrateLedger.join(", ")
        : `missing ${ledgerMissing.join(", ")} — prisma migrate status fails before any migration runs`,
    );
    check(
      `${RUNTIME} cannot touch Prisma's migration ledger`,
      runtimeLedger.length === 0,
      runtimeLedger.length === 0 ? "no access" : `REACHABLE: ${runtimeLedger.join(", ")}`,
    );

    // ---------------------------------------------------------------------
    // 8. The Supabase API roles cannot reach children's data.
    //
    //    This is the highest-blast-radius property of the database and until
    //    now nothing asserted it. `anon`, `authenticated` and `service_role`
    //    are the roles PostgREST assumes for requests arriving at the public
    //    Supabase REST endpoint; `anon` needs no credential at all.
    //
    //    Today they hold nothing on our four schemas — but by accident, not by
    //    decision. Supabase's own default privileges hand those three roles
    //    full DML on every new table in `public` (see `pg_default_acl` for
    //    grantor `postgres`), so the isolation rests entirely on our tables
    //    living outside `public`. One `GRANT USAGE ON SCHEMA app TO anon`, or
    //    one table created in `public` instead of `app`, publishes behaviour
    //    events to the open internet. Fail closed and loudly.
    // ---------------------------------------------------------------------
    const API_ROLES = ["anon", "authenticated", "service_role"] as const;
    const exposure = await client.query<{
      role: string;
      schema: string;
      usage: boolean;
      reachable: number;
    }>(
      `SELECT r AS role,
              s AS schema,
              has_schema_privilege(r, s, 'USAGE') AS usage,
              (SELECT count(*) FROM pg_tables t
                WHERE t.schemaname = s
                  AND (has_table_privilege(r, format('%I.%I', t.schemaname, t.tablename), 'SELECT')
                    OR has_table_privilege(r, format('%I.%I', t.schemaname, t.tablename), 'INSERT')
                    OR has_table_privilege(r, format('%I.%I', t.schemaname, t.tablename), 'UPDATE')
                    OR has_table_privilege(r, format('%I.%I', t.schemaname, t.tablename), 'DELETE'))
              )::int AS reachable
         FROM unnest($1::text[]) r CROSS JOIN unnest($2::text[]) s
        WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r)`,
      [API_ROLES, ALL_SCHEMAS],
    );

    for (const role of API_ROLES) {
      const rows = exposure.rows.filter((e) => e.role === role);
      if (rows.length === 0) {
        check(`${role} cannot reach the application schemas`, true, "role does not exist");
        continue;
      }
      const withUsage = rows.filter((e) => e.usage).map((e) => e.schema);
      const withTables = rows.filter((e) => e.reachable > 0);
      const ok = withUsage.length === 0 && withTables.length === 0;
      check(
        `${role} cannot reach the application schemas`,
        ok,
        ok
          ? "no USAGE, no table privileges"
          : `EXPOSED — ${[
              withUsage.length > 0 ? `USAGE on ${withUsage.join(", ")}` : null,
              withTables.length > 0
                ? `tables: ${withTables.map((e) => `${e.schema} (${e.reachable})`).join(", ")}`
                : null,
            ]
              .filter(Boolean)
              .join("; ")}`,
      );
    }

    // Our tables must stay out of `public`, because that is the one schema
    // where Supabase's defaults publish new tables to `anon` automatically.
    const inPublic = await client.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables
        WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
        ORDER BY tablename`,
    );
    check(
      "no application table sits in public",
      inPublic.rows.length === 0,
      inPublic.rows.length === 0
        ? "public holds only _prisma_migrations"
        : `IN PUBLIC (reachable by anon via PostgREST): ${inPublic.rows
            .map((t) => t.tablename)
            .join(", ")}`,
    );

    // ---------------------------------------------------------------------
    // 9. Views, which every check above silently skipped.
    //
    //    Sections 5 and 8 read `pg_tables`, and `pg_tables` does not list
    //    views. Nine exist — three in `app`, one in `events` and five in `ml`
    //    — so "steamkid_runtime cannot write to ml" was, until now, a claim
    //    about the one real table in `ml` and about none of the five
    //    `ml.v_*` projections the sentence was written to protect.
    //
    //    The gap is not cosmetic. A single-table view is auto-updatable, and
    //    PostgreSQL checks an auto-updatable write against the *view owner's*
    //    rights on the base table, not the caller's. So `INSERT` on
    //    `ml.v_consented_learner` granted to the runtime role would write to
    //    `app.learner` with the owner's authority — a way through the
    //    consent-filtered projection that reads as read-only everywhere else
    //    in this file.
    // ---------------------------------------------------------------------
    const views = await client.query<{
      schemaname: string;
      viewname: string;
      can_select: boolean;
      can_insert: boolean;
      can_update: boolean;
      can_delete: boolean;
    }>(
      `SELECT n.nspname AS schemaname, c.relname AS viewname,
              has_table_privilege($2, c.oid, 'SELECT') AS can_select,
              has_table_privilege($2, c.oid, 'INSERT') AS can_insert,
              has_table_privilege($2, c.oid, 'UPDATE') AS can_update,
              has_table_privilege($2, c.oid, 'DELETE') AS can_delete
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('v', 'm') AND n.nspname = ANY($1)
        ORDER BY 1, 2`,
      [ALL_SCHEMAS, RUNTIME],
    );

    for (const schema of ALL_SCHEMAS) {
      const inSchema = views.rows.filter((v) => v.schemaname === schema);
      if (inSchema.length === 0) continue;
      const unreadable = inSchema.filter((v) => !v.can_select);
      check(
        `${RUNTIME} can read all ${inSchema.length} view(s) in ${schema}`,
        unreadable.length === 0,
        unreadable.length === 0
          ? "SELECT"
          : `cannot read: ${unreadable.map((v) => v.viewname).join(", ")}`,
      );
      if ((READ_ONLY_SCHEMAS as readonly string[]).includes(schema)) {
        const writable = inSchema.filter((v) => v.can_insert || v.can_update || v.can_delete);
        check(
          `${RUNTIME} cannot write to any view in ${schema}`,
          writable.length === 0,
          writable.length === 0
            ? "no INSERT, UPDATE or DELETE on the training projections"
            : `WRITABLE: ${writable.map((v) => v.viewname).join(", ")} — an auto-updatable view writes as its owner`,
        );
      }
    }

    // ---------------------------------------------------------------------
    // 10. No function hands the runtime role someone else's authority.
    //
    //     A SECURITY DEFINER function executes as its owner. Every function
    //     in these schemas is owned by whoever ran the migration — today
    //     `steamkid_app`, after the cutover `steamkid_migrate` — so one
    //     marked SECURITY DEFINER and executable by the runtime role would
    //     be a DDL-capable credential reachable from application code, and
    //     section 4's ownership argument would stop being true.
    //
    //     All ten are SECURITY INVOKER today. That is the property worth
    //     pinning: it costs a migration one word to lose it.
    // ---------------------------------------------------------------------
    const definers = await client.query<{ fn: string; owner: string }>(
      `SELECT format('%I.%I', n.nspname, p.proname) AS fn,
              p.proowner::regrole::text AS owner
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = ANY($1)
          AND p.prosecdef
          AND has_function_privilege($2, p.oid, 'EXECUTE')
        ORDER BY 1`,
      [ALL_SCHEMAS, RUNTIME],
    );
    check(
      `no SECURITY DEFINER function is executable by ${RUNTIME}`,
      definers.rows.length === 0,
      definers.rows.length === 0
        ? "every function runs as its caller"
        : `ESCALATION: ${definers.rows
            .map((d) => `${d.fn} runs as ${d.owner}`)
            .join(", ")}`,
    );
  } finally {
    await client.end();
  }

  for (const result of results) {
    console.log(`${result.passed ? "PASS" : "FAIL"}  ${result.name} — ${result.detail}`);
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);

  if (failed.length > 0) {
    throw new Error(
      `${failed.length} grant check(s) failed: ${failed.map((f) => f.name).join("; ")}`,
    );
  }
  console.log(
    `${RUNTIME} can read and write every table it should, owns nothing, and cannot reach ml for writing.`,
  );
}

main().catch((error: Error) => {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
});
