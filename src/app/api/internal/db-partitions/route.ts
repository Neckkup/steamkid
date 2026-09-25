/**
 * `GET /api/internal/db-partitions`
 *
 * Vercel Cron endpoint — extends the behaviour pipe's partition runway.
 * Called on the 1st of each month via vercel.json crons.
 *
 * Idempotent: multiple calls in a month run one cheap SELECT and create nothing.
 *
 * Why this needs MIGRATE_DATABASE_URL, not DATABASE_URL: partition creation is
 * DDL and `steamkid_runtime` has no CREATE anywhere. `events.ensure_partition_runway`
 * is not SECURITY DEFINER by design, so EXECUTE on it grants the runtime role
 * nothing it could not already do. Routing a scheduler to the runtime URL
 * fails with 42501 on the one day of the month that actually matters.
 *
 * Alert path: returns 500 when runway < 30 days, causing Vercel to mark the
 * cron as failed and email the project owner.
 *
 * Security: `Authorization: Bearer <INTERNAL_CRON_SECRET>` required unless
 * APP_ENV=local. Vercel Cron sends `Authorization: Bearer $CRON_SECRET`; set
 * INTERNAL_CRON_SECRET to the same value in Vercel project settings
 * (Settings → Environment Variables → CRON_SECRET).
 */

import { Pool } from "pg";
import { NextResponse } from "next/server";

import { resolveMigrateUrl } from "@/lib/db/connection-env";
import { pgConnectionOptions } from "@/lib/db/pg-connection";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

const RUNWAY_MONTHS = 3;
const MIN_RUNWAY_DAYS = 30;

interface RunwayRow {
  readonly covered_until: string;
  readonly days_of_runway: number;
}

export async function GET(request: Request): Promise<Response> {
  if (!checkAuth(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const migrate = resolveMigrateUrl(process.env);
  if (!migrate) {
    const msg =
      "db-partitions cron: neither MIGRATE_DATABASE_URL nor DIRECT_URL is set. " +
      "DDL requires the migrator role — see scripts/ensure-partitions.ts.";
    console.error(msg);
    return NextResponse.json({ error: "migrate_url_missing" }, { status: 503 });
  }

  const pool = new Pool(pgConnectionOptions(migrate.url));
  try {
    const { rows } = await pool.query<{ partition_name: string; created: boolean }>(
      "SELECT * FROM events.ensure_partition_runway($1)",
      [RUNWAY_MONTHS],
    );

    const newPartitions = rows.filter((r) => r.created).map((r) => r.partition_name);

    const { rows: runwayRows } = await pool.query<RunwayRow>(
      "SELECT * FROM events.partition_runway",
    );
    const runway = runwayRows[0];
    if (!runway) {
      return NextResponse.json({ error: "partition_runway_view_empty" }, { status: 500 });
    }

    const days = Number(runway.days_of_runway);
    const coveredUntil = runway.covered_until;

    if (newPartitions.length > 0) {
      console.log(`db-partitions cron: created ${newPartitions.join(", ")}`);
    } else {
      console.log(`db-partitions cron: runway already covers ${rows.length} months; nothing to create`);
    }
    console.log(`db-partitions cron: covered until ${coveredUntil} (${days} days of runway)`);

    if (days < MIN_RUNWAY_DAYS) {
      console.error(
        `db-partitions cron: runway is under ${MIN_RUNWAY_DAYS} days — investigate why the schedule missed.`,
      );
      return NextResponse.json(
        { coveredUntil, daysOfRunway: days, newPartitions, alert: `runway_under_${MIN_RUNWAY_DAYS}_days` },
        { status: 500 },
      );
    }

    return NextResponse.json({ coveredUntil, daysOfRunway: days, newPartitions });
  } finally {
    await pool.end();
  }
}

function checkAuth(request: Request): boolean {
  if (env.APP_ENV === "local" && !env.INTERNAL_CRON_SECRET) return true;

  const secret = env.INTERNAL_CRON_SECRET;
  if (!secret) {
    console.error("INTERNAL_CRON_SECRET is not set; refusing db-partitions cron request");
    return false;
  }

  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return token === secret;
}
