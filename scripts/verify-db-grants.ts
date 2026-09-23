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
function connectionString(): string {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url || url.trim() === "") {
    throw new Error(
      "Neither DIRECT_URL nor DATABASE_URL is set. Both come from the Paperclip vault; see ADR 0005.",
    );
  }
  // pg 8.23 reads `sslmode=require` as `verify-full`, which Supabase's pooler
  // chain fails with a self-signed-certificate error that reads like an outage.
  // ADR 0005 carries the CA-pinning follow-up; this keeps the check runnable.
  return url.includes("uselibpqcompat") ? url : `${url}&uselibpqcompat=true`;
}

async function main(): Promise<void> {
  const client = new Client({ connectionString: connectionString() });
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
