# Runbook — Postgres backup and restore

- **Status (2026-09-22): written, NOT yet rehearsed.** No database exists to back
  up. `GET /api/agents/me/secrets` returns `{"secrets":[]}`, so there is no
  `DATABASE_URL`/`DIRECT_URL` to point any of this at. Every command below is
  written to be run as-is the day the connection card in
  [PRO-70](/PRO/issues/PRO-70) is accepted.
- **Owner:** Backend
- **Issue:** [PRO-16](/PRO/issues/PRO-16) — the gate that blocks real child data
- **Target system:** managed Supabase Postgres, reached over the IPv4 Supavisor
  pooler — [ADR 0005](../adr/0005-postgres-access-path.md), amending
  [ADR 0003](../adr/0003-managed-postgres-provider.md)

**The rule this runbook exists to enforce:** not one row of real child data lands in
production until a restore has actually been performed and its output recorded in
§5. A configured backup job is not a backup. Only a restore is.

## 1. Why this is not `pg_basebackup` + WAL archiving

The earlier plan on PRO-16 (19 Sep) assumed Postgres ran self-hosted on the
founder's machine at `supabase.homekup.com`, where we would own the data directory
and could archive WAL ourselves. ADR 0005 retired that host: its DNS is
orange-clouded Cloudflare, which forwards HTTP/HTTPS and never raw 5432. Re-measured
from a runner today:

```
aws-0-ap-southeast-1.pooler.supabase.com:5432 -> connected (133ms)
aws-0-ap-southeast-1.pooler.supabase.com:6543 -> connected (89ms)
supabase.homekup.com:5432                     -> timeout 8s
```

On managed Postgres we have **no filesystem and no superuser**, so
`pg_basebackup`, `archive_command` and a `recovery.signal` restore are all
unavailable to us. What is left is the provider's own snapshots plus **logical
dumps we take and store ourselves**. That is what this runbook is.

**Say the cost out loud:** logical dumps give an RPO equal to the dump interval —
daily dumps mean up to 24 h of a child's work can be lost. Real point-in-time
recovery on this provider is a paid tier feature, not something we can engineer
around. Choosing the interval is choosing how much work a child may redo; see §7.

## 2. What the provider gives us vs what we build

| Layer | Free tier | Pro tier | Ours either way |
| --- | --- | --- | --- |
| Daily managed backup | **none** | daily, 7-day retention | — |
| Point-in-time recovery | none | paid add-on | — |
| Copy outside the provider's account | never | never | **this runbook** |

The third row is the one that does not become someone else's job at any price. A
backup that lives only inside the provider's account shares a failure domain with
the database: a billing lapse, an account compromise, or an operator mistake takes
both. §4 is therefore mandatory regardless of which tier we end on.

## 3. Taking a dump

### 3.1 Where the job runs

**Not on a Paperclip runner** — verified today, `pg_dump` is not installed there and
a runner is ephemeral. The job runs in **GitHub Actions** on a schedule, in a
container that already has a matching client.

Two version rules, both of which cause silent-looking failures if broken:

- `pg_dump` major version must be **≥ the server's** major version. Pin the client
  image to the server's major (check it once with `SELECT version();` and record it
  in §6), do not rely on the runner image's default.
- The dump must use **`DIRECT_URL` (pooler port 5432, session mode)**, never
  `DATABASE_URL` (port 6543, transaction mode). `pg_dump` needs a session-long
  snapshot; against the transaction pooler it fails or, worse, produces an
  inconsistent dump.

### 3.2 The command

```bash
# $DIRECT_URL = postgresql://<user>:<pw>@aws-<n>-ap-southeast-1.pooler.supabase.com:5432/postgres
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

pg_dump "$DIRECT_URL" \
  --format=custom \
  --compress=9 \
  --no-owner --no-privileges \
  --schema=identity --schema=app --schema=events --schema=ml \
  --file="steamkid-${STAMP}.dump"
```

- `--format=custom` so `pg_restore` can do selective and parallel restores.
- `--no-owner --no-privileges` because the roles on a restore target will not match
  the provider's.
- All four schemas, **including `identity`**. This is a backup, not a training
  export: it must contain the PII, which is exactly why §3.3 is not optional. The
  consent-filtered, identity-free artifact is a different thing and lives in
  `ml.training_export_run`.

Immediately after the dump, capture a **manifest** from the same source database —
this is what §5 compares against, and without it a restore proves nothing:

```bash
psql "$DIRECT_URL" -At -F',' -f scripts/sql/backup-manifest.sql > "steamkid-${STAMP}.manifest.csv"
```

The manifest query is §5.2. Store it next to the dump, unencrypted (it is counts
and timestamps only, no child data).

### 3.3 Encrypt before it leaves CI

The dump contains children's names, guardian contacts and free-text answers. It is
encrypted in the job, before upload, with a public key whose private half is **not**
in CI:

```bash
age --recipient "$BACKUP_AGE_RECIPIENT" \
    --output "steamkid-${STAMP}.dump.age" "steamkid-${STAMP}.dump"
rm -f "steamkid-${STAMP}.dump"
```

`BACKUP_AGE_RECIPIENT` is a public key and may sit in the workflow file. The private
key is a Paperclip secret held for the restore drill only, and never enters GitHub
Actions — CI can create backups it cannot read. Losing that private key loses every
backup, so it is escrowed per §6.

### 3.4 Do not commit the scheduled workflow until the secrets exist

A `schedule:`d workflow with no `DIRECT_URL` fails every night and trains everyone
to ignore red. Commit the workflow in the same change that receives the secrets.

## 4. Where backups are stored

**Requirement, not preference: a different failure domain from the database.** The
database is managed Postgres in AWS `ap-southeast-1` inside our provider account.
A backup in that same account is not a backup.

**Status: no destination exists yet.** Object storage needs an account, and per
PRO-16 nobody on the team signs up for storage themselves — it is requested through
[CEO](/PRO/agents/ceo). Two candidates, both **USD 0/mo** at our volume against the
approved USD 37/mo ceiling:

| Candidate | Free allowance | Why it qualifies |
| --- | --- | --- |
| Cloudflare R2 | 10 GB storage, no egress fee | different vendor, different account |
| Backblaze B2 | 10 GB storage | different vendor, different account |

Whichever is chosen: a bucket used by nothing else, object-lock or versioning on if
available, write-only credentials for CI (`PutObject` and nothing else — a CI token
that can delete backups is a ransomware amplifier), and read credentials held only
for drills.

Until that bucket exists this runbook cannot be executed end to end, and PRO-16
cannot close.

## 5. The restore drill — the only step that closes PRO-16

Run this on the first backup, then **quarterly**, and after any schema migration
that adds a schema. A drill that is not written down did not happen.

### 5.1 Restore into a throwaway instance

Never restore into anything the app can reach. Use a disposable container:

```bash
docker run -d --name restore-drill -e POSTGRES_PASSWORD=drill -p 55432:5432 postgres:<server-major>
export DRILL_URL="postgresql://postgres:drill@localhost:55432/postgres"

age --decrypt --identity "$BACKUP_AGE_KEY" \
    --output restore.dump "steamkid-<stamp>.dump.age"

pg_restore --dbname="$DRILL_URL" --no-owner --no-privileges --jobs=4 restore.dump
```

Expected noise that is **not** a failure: `--no-owner` warnings, and errors about
extensions owned by the provider's roles. Anything that fails to create a table,
view or partition **is** a failure — read the whole log, do not just check the exit
code, and note that `pg_restore` exits non-zero on ignorable role errors too.

### 5.2 Verify the data actually came back

[`scripts/sql/backup-manifest.sql`](../../scripts/sql/backup-manifest.sql) is the
executable version of this check — one file, run against **both** the source (at
dump time, §3.2) and the drill instance (after restore). Identical output on both
sides is the pass condition. Keep the checks in that file and nowhere else, so the
two sides can never drift apart.

```bash
psql "$DRILL_URL" -At -F',' -f scripts/sql/backup-manifest.sql > drill.manifest.csv
diff "steamkid-<stamp>.manifest.csv" drill.manifest.csv && echo "MANIFEST MATCH"
```

What it asserts, and why each line is in there:

| Section | Check | Why |
| --- | --- | --- |
| `inventory` | table count per schema | a schema that silently failed to restore is invisible in row counts |
| `rowcount` | 14 tables including all of `identity` | the tables whose loss is unrecoverable |
| `watermark` | `max(event_time)` | **this is the point in time we recovered to** — the number PRO-16 asks for |
| `partition` | partitions of `events.behavior_event` | a restore that flattens partitions breaks retention-by-`DROP PARTITION` |
| `view` | `ml.v_grading_examples` row count | proves the behaviour + submission + verdict + correction join still resolves |
| `invariant` | `unconsented_leaks` | consent gating survived as structure, not as an accident of the data |

Pass condition, all four, no exceptions:

1. the two manifests `diff` clean;
2. `watermark` is within the dump interval of the dump's start time;
3. the `partition` rows are non-empty;
4. `invariant/unconsented_leaks = 0`.

A clean `diff` on an empty database proves nothing. The first drill runs against a
database seeded with synthetic learners, events, submissions and one teacher
correction, so every row count above is non-zero.

### 5.3 Record it, then destroy the drill instance

Append to §6 below, in the same change: dump timestamp, the `watermark` recovered,
restore duration, the four pass/fail results, and anything that surprised you. Then:

```bash
docker rm -f restore-drill && rm -f restore.dump
```

The decrypted dump is real child data on a laptop. It does not survive the drill.

## 6. Drill log

| Date | Dump stamp | Recovered to (`watermark`) | Duration | Result | Notes |
| --- | --- | --- | --- | --- | --- |
| — | — | — | — | — | No drill has been run. No database exists yet (PRO-70). |

Also record here, once, when the database first exists: server major version,
pooler hostname, and where the age private key is escrowed.

## 7. Cost, retention, and the RPO we are choosing

Dump size is roughly proportional to `events.behavior_event`, which is the fastest
growing table by an order of magnitude. Measure it (`pg_total_relation_size`) at
first backup and write the number here; until then the storage sizing is a guess
and should not be presented as anything else.

Starting retention, revisit at first real traffic:

- daily dump, kept 14 days;
- weekly dump, kept 8 weeks;
- monthly dump, kept 12 months.

Both candidate buckets in §4 are free at this volume, so retention is a recovery
decision, not a cost one, until the daily dump exceeds ~1 GB compressed.

## 8. What this runbook does not give us

- **No point-in-time recovery.** Worst case we lose everything since the last dump.
  Closing that gap means the provider's paid tier plus the PITR add-on, which is a
  spend decision (CEO) and a provider re-decision (CTO, per ADR 0003's re-decision
  trigger — Neon includes history retention in a cheaper tier).
- **No protection against a bad migration that is dumped before anyone notices.**
  The dump faithfully preserves the damage. This is why migrations are reversible
  or carry a documented forward fix.
- **No test of the provider's own restore path.** We only test ours.
