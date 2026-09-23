/**
 * Rehearse the restore drill, out loud.
 *
 * `npm run drill:rehearse`
 *
 * PRO-16 will only close on a restore of the *real* database, and that is
 * blocked on PRO-70 (no `DATABASE_URL` exists). This script is the part that can
 * be proven today: it backs up a synthetic database, moves the source forward,
 * restores the backup into a second instance, and prints the manifest from both
 * sides plus the `diff`.
 *
 * Why print it at all when `src/lib/db/restore-drill.test.ts` asserts the same
 * thing: the pass condition in `docs/runbooks/postgres-backup-restore.md` §5.2
 * is "the two manifests diff clean", and a reviewer should be able to *see* two
 * manifests and an empty diff rather than trust a green tick. Both callers share
 * `src/lib/db/drill-rehearsal.ts`, so the printed run and the asserted run can
 * never drift apart.
 *
 * **Read the last block before quoting this anywhere.** This is PGlite with
 * synthetic learners, not managed Postgres with `pg_dump`, and it does not
 * satisfy the drill PRO-16 demands.
 *
 * Every learner, answer and correction here is invented. No real child's row
 * exists in this repository.
 */

import { formatManifest, manifestValue, MANIFEST_SQL_PATH } from "@/lib/db/backup-manifest";
import { rehearseRestoreDrill, UNSEEDED_MANIFEST_TABLES } from "@/lib/db/drill-rehearsal";

const WATERMARK_KEY = "events.behavior_event.max_event_time";

function heading(step: string, title: string): void {
  console.log(`\n${"=".repeat(78)}\n${step}  ${title}\n${"=".repeat(78)}`);
}

/** A unified-ish diff of two manifests. Empty output is the pass condition. */
function diff(left: readonly string[], right: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of left) if (!right.includes(line)) out.push(`- ${line}`);
  for (const line of right) if (!left.includes(line)) out.push(`+ ${line}`);
  return out;
}

async function main(): Promise<void> {
  console.log("Restore-drill rehearsal — synthetic data, PGlite (Postgres 17), no credentials.");
  console.log(`Manifest: ${MANIFEST_SQL_PATH}`);

  const drill = await rehearseRestoreDrill();

  try {
    heading("1", "Manifest of the SOURCE, at the moment the backup was taken");
    console.log(formatManifest(drill.manifestAtDump).trimEnd());
    console.log(
      `\nTables left empty on purpose: ${UNSEEDED_MANIFEST_TABLES.join(", ")}` +
        `\nBackup artifact: ${(drill.dumpBytes / 1024 / 1024).toFixed(1)} MiB — a whole data` +
        " directory, almost all of it an empty cluster. It says nothing about the size\n" +
        "of a real `pg_dump`, so do not use it for the sizing note in runbook §7.",
    );

    heading("2", "The source moves on — one more visit lands AFTER the backup");
    const at = manifestValue(drill.manifestAtDump, "watermark", WATERMARK_KEY)!;
    const after = manifestValue(drill.manifestSourceAfterDump, "watermark", WATERMARK_KEY)!;
    console.log(`watermark at dump time : ${at}`);
    console.log(`watermark now (source) : ${after}`);
    console.log(
      "Everything between those two timestamps is what a restore of this backup loses.\n" +
        "That gap is the RPO, and it is a choice, not an accident (runbook §1).",
    );

    heading("3", "Manifest of the RESTORED instance");
    console.log(formatManifest(drill.manifestRestored).trimEnd());
    console.log(`\nRestore took ${drill.restoreMs} ms.`);

    heading("4", "diff  (empty = the runbook §5.2 pass condition)");
    const delta = diff(drill.manifestAtDump, drill.manifestRestored);
    console.log(delta.length === 0 ? "(no differences)  MANIFEST MATCH" : delta.join("\n"));

    heading("5", "The four pass conditions, evaluated");
    const partitions = drill.manifestRestored.filter((line) => line.startsWith("partition,"));
    const leaks = manifestValue(drill.manifestRestored, "invariant", "unconsented_leaks");
    const restoredWatermark = manifestValue(drill.manifestRestored, "watermark", WATERMARK_KEY);
    const checks = [
      ["1. manifests diff clean", delta.length === 0],
      ["2. recovered to the dump's point in time", restoredWatermark === at],
      ["3. partitions came back as partitions", partitions.length > 0],
      ["4. unconsented_leaks = 0", leaks === "0"],
    ] as const;
    for (const [label, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);

    heading("6", "What this rehearsal is NOT");
    console.log(
      [
        "- not `pg_dump`/`pg_restore`: PGlite dumps a data directory, the real drill",
        "  takes a logical dump over the pooler and restores it into a server",
        "- not the real database: no `DATABASE_URL` exists yet (PRO-70)",
        "- not a second failure domain: nothing was uploaded anywhere (PRO-85, on hold)",
        "- not evidence of encryption at rest, and not a test of the provider's own",
        "  restore path",
        "",
        "PRO-16 stays blocked. The drill-log row in the runbook §6 stays empty until",
        "this same procedure runs against the real database.",
      ].join("\n"),
    );

    if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
  } finally {
    await drill.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
