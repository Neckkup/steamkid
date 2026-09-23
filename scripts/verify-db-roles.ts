/**
 * Prove that the runtime database role cannot reshape the database.
 *
 * `npm run verify:roles`
 *
 * PRO-103 asks for one thing that a document cannot give you: evidence that
 * `steamkid_runtime` is *actually* refused when it tries `DROP`, `ALTER`, or
 * removing an append-only trigger. Writing "DML only" in an ADR is a claim.
 * This script is the check, and it is written so that it fails loudly when the
 * claim stops being true — a privilege that quietly comes back is exactly the
 * kind of regression nobody notices until a migration runs as the wrong role.
 *
 * It needs two credentials, both from the Paperclip vault, never from the repo:
 *
 *   MIGRATE_DATABASE_URL (or DIRECT_URL)   session mode (5432), role
 *                                          `steamkid_migrate` — creates the fixture
 *   RUNTIME_DATABASE_URL (or DATABASE_URL) transaction mode (6543), role
 *                                          `steamkid_runtime` — is the subject
 *
 * Two accepted names each, new one first, because the old two are still bound to
 * the retiring `steamkid_app` (`src/lib/db/connection-env.ts`). This script
 * prints which variable supplied each value and then asserts the role the server
 * reports, so reading the wrong one shows up here as a named failure instead of
 * as thirteen checks that pass for the wrong reason.
 *
 * The fixture is a throwaway table in `events`, created by the migrator, and it
 * is dropped again at the end. It lives in a real application schema on purpose:
 * that is the only way to exercise the `ALTER DEFAULT PRIVILEGES` path, which is
 * what silently hands the runtime role DML on every table a future migration
 * creates. A probe in a scratch schema would pass while the real thing is broken.
 *
 * Nothing here touches a real learner. The fixture holds one row of the string
 * "synthetic".
 */

import { randomBytes } from "node:crypto";

import { Client } from "pg";

import {
  describeNames,
  MIGRATE_URL_NAMES,
  resolveConnectionUrl,
  RUNTIME_URL_NAMES,
  type ConnectionUrlName,
  type ResolvedConnectionUrl,
} from "../src/lib/db/connection-env";
import { pgConnectionOptions } from "../src/lib/db/pg-connection";

/** Postgres `insufficient_privilege`. The only rejection we accept as proof. */
const INSUFFICIENT_PRIVILEGE = "42501";

type Check = {
  readonly name: string;
  readonly sql: string;
  /** What the runtime role must be told when it tries this. */
  readonly expect: "denied" | "allowed" | "blocked_by_trigger";
};

type Result = Check & { readonly passed: boolean; readonly detail: string };

function requireUrl(names: readonly ConnectionUrlName[]): ResolvedConnectionUrl {
  const resolved = resolveConnectionUrl(process.env, names);
  if (!resolved) {
    throw new Error(
      `Neither ${describeNames(names)} is set. Both roles come from the Paperclip ` +
        `vault; see ADR 0005.`,
    );
  }
  return resolved;
}

/**
 * Report which role a connection actually authenticated as.
 *
 * Worth its own round trip: through Supavisor the login name carries a
 * `.<project-ref>` suffix, and a copy-paste slip that points both variables at
 * the same role would otherwise make every negative check "pass" for the wrong
 * reason.
 */
async function currentUser(client: Client): Promise<string> {
  const { rows } = await client.query<{ current_user: string }>(
    "select current_user",
  );
  return rows[0].current_user;
}

async function run(client: Client, check: Check): Promise<Result> {
  try {
    await client.query(check.sql);
    return {
      ...check,
      passed: check.expect === "allowed",
      detail: check.expect === "allowed" ? "allowed, as intended" : "SUCCEEDED — it must not",
    };
  } catch (error) {
    const code = (error as { code?: string }).code ?? "";
    const message = (error as Error).message.split("\n")[0];

    if (check.expect === "denied") {
      // Only 42501 counts. A typo that yields `undefined_table` would otherwise
      // read as a privilege denial and turn this script into a rubber stamp.
      return {
        ...check,
        passed: code === INSUFFICIENT_PRIVILEGE,
        detail:
          code === INSUFFICIENT_PRIVILEGE
            ? `denied (${code})`
            : `rejected with ${code || "no code"}, which is not a privilege denial: ${message}`,
      };
    }

    if (check.expect === "blocked_by_trigger") {
      return {
        ...check,
        passed: code !== INSUFFICIENT_PRIVILEGE,
        detail:
          code !== INSUFFICIENT_PRIVILEGE
            ? `refused by the append-only trigger: ${message}`
            : `denied by privileges (${code}) — the trigger was never reached, so this proves nothing`,
      };
    }

    return { ...check, passed: false, detail: `${code}: ${message}` };
  }
}

async function main(): Promise<void> {
  const migratorUrl = requireUrl(MIGRATE_URL_NAMES);
  const runtimeUrl = requireUrl(RUNTIME_URL_NAMES);
  // Through `pgConnectionOptions`, not a raw connection string: `pg` 8.23 reads
  // `sslmode=require` as `verify-full` and Supabase's pooler presents a
  // self-signed chain, so a raw string dies with "self-signed certificate in
  // certificate chain" — a TLS error that reads like an outage, on a check whose
  // whole job is to be unambiguous about privileges.
  const migrator = new Client(pgConnectionOptions(migratorUrl.url));
  const runtime = new Client(pgConnectionOptions(runtimeUrl.url));

  // A fresh name per run, so a crashed earlier run cannot make this one pass by
  // colliding with leftovers.
  const table = `events.role_probe_${randomBytes(6).toString("hex")}`;
  const trigger = "role_probe_append_only";

  await migrator.connect();
  await runtime.connect();

  const migratorUser = await currentUser(migrator);
  const runtimeUser = await currentUser(runtime);

  console.log(`${migratorUrl.name} → ${migratorUser}`);
  console.log(`${runtimeUrl.name} → ${runtimeUser}`);

  // Both roles are asserted, not just the runtime one. A migrator URL that
  // quietly fell back to `steamkid_app` would have created every future table
  // under the role this ticket retires — which is exactly how the 09:17
  // regression happened, and nothing about it looked wrong. `connection-env.ts`
  // now refuses that URL outright, so this is the second of two fences; it stays
  // because it asserts what the *server* reports rather than what the URL says.
  //
  // The message is built rather than thrown here: these checks run before the
  // `try`/`finally` that closes the two clients, so throwing directly would leave
  // both connections open and Node would hang instead of exiting non-zero. A
  // check that hangs is worse than one that fails.
  const preflight =
    migratorUser === runtimeUser
      ? `Both URLs authenticate as "${runtimeUser}". That is the single-role setup ` +
        `PRO-103 exists to remove; there is nothing to verify.`
      : runtimeUser !== "steamkid_runtime"
        ? `${runtimeUrl.name} authenticates as "${runtimeUser}", not steamkid_runtime. ` +
          `The application must never hold the migrator credential.`
        : migratorUser !== "steamkid_migrate"
          ? `${migratorUrl.name} authenticates as "${migratorUser}", not ` +
            `steamkid_migrate. Migrations must not run as any other role — every ` +
            `object they create would be owned by it.`
          : null;

  if (preflight) {
    await migrator.end();
    await runtime.end();
    throw new Error(preflight);
  }

  try {
    await migrator.query(`
      CREATE TABLE ${table} (
        id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        note text NOT NULL
      );
      CREATE OR REPLACE FUNCTION events.role_probe_append_only_fn()
        RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        RAISE EXCEPTION '% is append-only: % is not allowed.', TG_TABLE_NAME, TG_OP;
      END
      $fn$;
      CREATE TRIGGER ${trigger}
        BEFORE UPDATE OR DELETE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION events.role_probe_append_only_fn();
    `);

    // The migrator commits one row. This matters more than it looks: every
    // check below runs in its own rolled-back transaction, so the runtime
    // role's own INSERT is gone by the time UPDATE is tried. Against an empty
    // table a FOR EACH ROW trigger never fires and `UPDATE` reports success
    // over zero rows — which reads exactly like "the append-only guard is
    // missing" while proving nothing either way.
    await migrator.query(`INSERT INTO ${table} (note) VALUES ('synthetic')`);

    const checks: readonly Check[] = [
      // Positive control. Without this, a runtime role that had lost *all*
      // access would sail through every negative check below.
      {
        name: "INSERT into a migrator-created table",
        sql: `INSERT INTO ${table} (note) VALUES ('synthetic')`,
        expect: "allowed",
      },
      { name: "SELECT from it", sql: `SELECT id FROM ${table}`, expect: "allowed" },

      // The append-only guarantee: reached through the trigger, not through a
      // privilege denial, because the runtime role legitimately holds UPDATE.
      {
        name: "UPDATE is stopped by the append-only trigger",
        sql: `UPDATE ${table} SET note = 'tampered'`,
        expect: "blocked_by_trigger",
      },
      {
        name: "DELETE is stopped by the append-only trigger",
        sql: `DELETE FROM ${table}`,
        expect: "blocked_by_trigger",
      },

      // The point of the whole ticket.
      { name: "DROP TABLE", sql: `DROP TABLE ${table}`, expect: "denied" },
      {
        name: "ALTER TABLE ... ADD COLUMN",
        sql: `ALTER TABLE ${table} ADD COLUMN sneaked text`,
        expect: "denied",
      },
      {
        name: "DROP TRIGGER (removing the append-only guard)",
        sql: `DROP TRIGGER ${trigger} ON ${table}`,
        expect: "denied",
      },
      {
        name: "ALTER TABLE ... DISABLE TRIGGER (the quieter way round the guard)",
        sql: `ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`,
        expect: "denied",
      },
      {
        name: "CREATE TABLE in events",
        sql: `CREATE TABLE events.role_probe_should_not_exist (id int)`,
        expect: "denied",
      },
      {
        name: "CREATE TABLE in identity (where the PII lives)",
        sql: `CREATE TABLE identity.role_probe_should_not_exist (id int)`,
        expect: "denied",
      },
      { name: "DROP SCHEMA events", sql: `DROP SCHEMA events CASCADE`, expect: "denied" },
      { name: "CREATE SCHEMA", sql: `CREATE SCHEMA role_probe_schema`, expect: "denied" },
      {
        name: "TRUNCATE (not granted, and not covered by a row trigger)",
        sql: `TRUNCATE ${table}`,
        expect: "denied",
      },
    ];

    // Guard the guard: if the runtime role cannot see that committed row, the
    // two trigger checks below would pass vacuously.
    const { rows: seeded } = await runtime.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${table}`,
    );
    if (seeded[0].count !== "1") {
      throw new Error(
        `Fixture row is not visible to ${runtimeUser} (count=${seeded[0].count}). ` +
          `The append-only checks would not touch a row and would prove nothing.`,
      );
    }

    const results: Result[] = [];
    for (const check of checks) {
      // Each statement gets its own transaction: one failure inside a shared
      // transaction would abort it and make every later check fail as
      // `25P02 in_failed_sql_transaction` instead of on its own merits.
      await runtime.query("BEGIN");
      const result = await run(runtime, check);
      await runtime.query("ROLLBACK");
      results.push(result);
    }

    console.log("");
    for (const result of results) {
      console.log(`${result.passed ? "PASS" : "FAIL"}  ${result.name} — ${result.detail}`);
    }

    const failed = results.filter((result) => !result.passed);
    console.log("");
    console.log(`${results.length - failed.length}/${results.length} checks passed`);

    if (failed.length > 0) {
      throw new Error(
        `${failed.length} role check(s) failed: ${failed.map((f) => f.name).join("; ")}`,
      );
    }
    console.log("steamkid_runtime holds DML and no DDL, and cannot remove an append-only trigger.");
  } finally {
    // Best effort: the fixture must not outlive the run even if a check threw.
    await migrator
      .query(`DROP TABLE IF EXISTS ${table} CASCADE`)
      .catch((error: Error) => console.error(`cleanup: ${error.message}`));
    await migrator
      .query(`DROP FUNCTION IF EXISTS events.role_probe_append_only_fn() CASCADE`)
      .catch((error: Error) => console.error(`cleanup: ${error.message}`));
    await migrator.end();
    await runtime.end();
  }
}

main().catch((error: Error) => {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
});
