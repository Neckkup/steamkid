/**
 * A rehearsal of the restore drill in `docs/runbooks/postgres-backup-restore.md`.
 *
 * **This is not the drill PRO-16 asks for, and must never be presented as one.**
 * The drill that opens the gate is a `pg_dump` of the real managed Postgres,
 * restored into a throwaway server, and it is blocked on PRO-70: no
 * `DATABASE_URL` exists yet. What runs here is the *procedure*, on synthetic
 * data, in the one Postgres we do have — see `drill-rehearsal.ts`.
 *
 * It exists because the fingerprint the real drill will be judged by,
 * `scripts/sql/backup-manifest.sql`, had never been executed against anything.
 * A comparison file that has never run is a comparison file that fails at 3am on
 * the night it matters. So this proves three things now, none of which need a
 * credential:
 *
 *   1. the manifest **runs** against the schema the migrations actually produce;
 *   2. it **round-trips** — identical output either side of a real dump/restore;
 *   3. it **discriminates** — a restore that lost rows, lost a partition, or
 *      lost the consent join fails the comparison instead of passing quietly.
 *
 * (3) is the one worth having. A manifest that always matches is worse than no
 * manifest: it converts "we have not checked" into "we checked and it was fine".
 *
 * What it does not prove: `pg_dump`/`pg_restore` behaviour, the provider's
 * pooler, encryption at rest, or that a backup ever reached a second failure
 * domain (PRO-85). Synthetic data throughout.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { formatManifest, manifestValue, runBackupManifest } from "./backup-manifest";
import {
  rehearseRestoreDrill,
  UNSEEDED_MANIFEST_TABLES,
  type RehearsalResult,
} from "./drill-rehearsal";

const WATERMARK_KEY = "events.behavior_event.max_event_time";

let drill: RehearsalResult;

beforeAll(async () => {
  drill = await rehearseRestoreDrill();
}, 180_000);

afterAll(async () => {
  await drill?.close();
});

describe("the manifest itself", () => {
  it("runs against the schema the migrations produce", () => {
    // Before this test the file had never been executed anywhere. A typo in a
    // table name would have surfaced during a real incident.
    expect(drill.manifestAtDump.length).toBeGreaterThan(10);
    expect(drill.manifestAtDump.every((line) => line.split(",").length >= 3)).toBe(true);
  });

  it("counts real rows, so a clean comparison is not vacuous", () => {
    const empty = drill.manifestAtDump
      .filter((line) => line.startsWith("rowcount,"))
      .filter((line) => line.endsWith(",0"))
      .map((line) => line.split(",")[1]!);

    // Anything empty here must be a known, listed gap — not a surprise.
    expect(empty).toEqual(UNSEEDED_MANIFEST_TABLES);
  });

  it("reports the recovery point and the structural consent invariant", () => {
    const watermark = manifestValue(drill.manifestAtDump, "watermark", WATERMARK_KEY);

    expect(watermark).toBeDefined();
    expect(watermark).not.toBe("empty");
    expect(manifestValue(drill.manifestAtDump, "invariant", "unconsented_leaks")).toBe("0");
    expect(
      drill.manifestAtDump.filter((line) => line.startsWith("partition,")).length,
    ).toBeGreaterThan(0);
  });
});

describe("the restored instance", () => {
  it("is a different database, not the same one under another name", async () => {
    // Guards against the rehearsal silently degenerating into comparing the
    // source with itself, which would make every assertion below meaningless.
    await drill.source.query(`CREATE TABLE IF NOT EXISTS app._drill_probe (id int)`);
    const { rows } = await drill.restored.query<{ exists: boolean }>(
      `SELECT to_regclass('app._drill_probe') IS NOT NULL AS exists`,
    );
    expect(rows[0]?.exists).toBe(false);
    await drill.source.query(`DROP TABLE app._drill_probe`);
  });

  it("reproduces the manifest taken at dump time, line for line", () => {
    // The runbook §5.2 pass condition, executed.
    expect(formatManifest(drill.manifestRestored)).toBe(formatManifest(drill.manifestAtDump));
  });

  it("stops at the point in time the dump was taken", () => {
    const at = manifestValue(drill.manifestAtDump, "watermark", WATERMARK_KEY)!;
    const after = manifestValue(drill.manifestSourceAfterDump, "watermark", WATERMARK_KEY)!;

    expect(manifestValue(drill.manifestRestored, "watermark", WATERMARK_KEY)).toBe(at);
    // The second visit really did land on the source, so the restore is behind
    // it by design — this is the RPO the runbook §1 says out loud.
    expect(Date.parse(after)).toBeGreaterThan(Date.parse(at));
  });

  it("does not contain the session that arrived after the dump", async () => {
    const { rows } = await drill.restored.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM events.session WHERE id = $1::uuid`,
      [drill.laterSessionId],
    );
    expect(rows[0]?.count).toBe("0");
  });

  it("keeps partitions as partitions", async () => {
    const { rows } = await drill.restored.query<{ relname: string }>(
      `SELECT c.relname FROM pg_inherits i
       JOIN pg_class c ON c.oid = i.inhrelid
       JOIN pg_class p ON p.oid = i.inhparent
       WHERE p.relname = 'behavior_event'`,
    );
    // Retention is DROP PARTITION; a flattened restore breaks it later, long
    // after anyone would connect the two facts.
    expect(rows.length).toBeGreaterThan(0);
  });

  it("carries the consent gate as structure, not as leftover data", async () => {
    const { rows } = await drill.restored.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM events.behavior_event WHERE learner_id = $1::uuid`,
      [drill.refusing.learnerId],
    );
    // The refusing learner's events were never written, so there is nothing to
    // restore — and `ml.v_consented_learner` still gates on a live grant.
    expect(rows[0]?.count).toBe("0");
    expect(manifestValue(drill.manifestRestored, "invariant", "unconsented_leaks")).toBe("0");
  });
});

/**
 * The half of a drill nobody runs: proving the check can fail.
 *
 * Each case damages the restored database the way a bad restore would, reads the
 * manifest, and rolls back. DDL is transactional in Postgres, so the instance is
 * untouched afterwards and these cases do not depend on test order.
 */
describe("the comparison fails when a restore is wrong", () => {
  async function manifestWith(damage: string) {
    await drill.restored.pg.exec("BEGIN");
    try {
      await drill.restored.pg.exec(damage);
      return await runBackupManifest(drill.restored);
    } finally {
      await drill.restored.pg.exec("ROLLBACK");
    }
  }

  it("catches a partition that came back detached from its parent", async () => {
    const { rows } = await drill.restored.query<{ relname: string }>(
      `SELECT c.relname FROM pg_inherits i
       JOIN pg_class c ON c.oid = i.inhrelid
       JOIN pg_class p ON p.oid = i.inhparent
       WHERE p.relname = 'behavior_event' ORDER BY c.relname`,
    );

    const damaged = await manifestWith(
      rows
        .map((row) => `ALTER TABLE events.behavior_event DETACH PARTITION events.${row.relname};`)
        .join("\n"),
    );

    expect(damaged).not.toEqual(drill.manifestAtDump);
    expect(damaged.filter((line) => line.startsWith("partition,"))).toEqual([]);
    // The rows in those partitions stop being visible through the parent, which
    // is the loss the count is there to notice.
    expect(manifestValue(damaged, "rowcount", "events.behavior_event")).toBe("0");
  });

  it("catches a table that restored short", async () => {
    const damaged = await manifestWith(`DELETE FROM events.event_registry;`);

    expect(damaged).not.toEqual(drill.manifestAtDump);
    expect(manifestValue(damaged, "rowcount", "events.event_registry")).toBe("0");
  });

  it("catches an export view that came back without its consent join", async () => {
    const damaged = await manifestWith(
      `CREATE OR REPLACE VIEW ml.v_consented_learner AS
         SELECT l.id AS learner_id, l.public_ref, l.grade_band, l.locale FROM app.learner l;`,
    );

    // This is the whole reason that line is in the manifest: a view rebuilt by
    // hand, without the join, exposes a child whose guardian said no.
    expect(manifestValue(damaged, "invariant", "unconsented_leaks")).not.toBe("0");
  });
});
