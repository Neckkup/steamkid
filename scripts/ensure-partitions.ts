/**
 * Keep the behaviour pipe's partition runway ahead of now().
 *
 *   npm run db:partitions            # extend to 3 months ahead
 *   npm run db:partitions -- 6       # or further
 *   npm run db:partitions -- --check # report only, non-zero exit if short
 *
 * This is the command a scheduler runs. It is deliberately a plain script and
 * not a `pg_cron` job or a Vercel Cron route: partition maintenance must keep
 * working when the host changes, and PRO-16 already plans a move off Supabase
 * Cloud. Whoever owns the schedule points it at this one command.
 *
 * Idempotent — running it twice, or ten times a day, changes nothing. The cost
 * of running it too often is one cheap query; the cost of not running it is a
 * 500 on every batch from the first of an uncovered month, and behaviour events
 * cannot be collected twice.
 */

import { Pool } from "pg";

import { resolveMigrateUrl } from "../src/lib/db/connection-env";
import { pgConnectionOptions } from "../src/lib/db/pg-connection";

/** Alert threshold. A month of warning is enough for a human to notice. */
const MIN_RUNWAY_DAYS = 30;

interface RunwayRow {
  readonly covered_until: string;
  readonly days_of_runway: number;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check");
  const months = Number(args.find((a) => /^\d+$/.test(a)) ?? 3);

  // The migrator credential only, with no fallback to the runtime one: creating
  // a partition is DDL. Under the PRO-103 role split `steamkid_runtime` has no
  // CREATE anywhere — and `events.ensure_partition_runway` is not SECURITY
  // DEFINER, deliberately, so EXECUTE on it grants the runtime role nothing it
  // could not already do. Pointing a scheduler at the runtime URL therefore
  // fails with 42501 on the one day of the month it matters, and a month of
  // behaviour events has nowhere to land. Data we do not capture is gone for
  // good, so this refuses to run rather than fall back.
  const migrate = resolveMigrateUrl(process.env);
  if (!migrate) {
    throw new Error(
      "Neither MIGRATE_DATABASE_URL nor DIRECT_URL is set. The runtime URL is not " +
        "a substitute — see above.",
    );
  }

  const pool = new Pool(pgConnectionOptions(migrate.url));
  try {
    if (!checkOnly) {
      const { rows } = await pool.query<{ partition_name: string; created: boolean }>(
        "SELECT * FROM events.ensure_partition_runway($1)",
        [months],
      );
      const created = rows.filter((r) => r.created);
      console.log(
        created.length === 0
          ? `runway already covers ${rows.length} months; nothing to create`
          : `created ${created.map((r) => r.partition_name).join(", ")}`,
      );
    }

    const { rows } = await pool.query<RunwayRow>("SELECT * FROM events.partition_runway");
    const runway = rows[0];
    if (!runway) {
      throw new Error("events.partition_runway returned nothing — is the pipe migrated?");
    }

    const days = Number(runway.days_of_runway);
    console.log(`partitions cover until ${runway.covered_until} (${days} days of runway)`);

    if (days < MIN_RUNWAY_DAYS) {
      // Non-zero exit so a scheduler's own failure alerting does the shouting.
      console.error(
        `runway is under ${MIN_RUNWAY_DAYS} days. Run without --check, and find out why the schedule is not running.`,
      );
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
