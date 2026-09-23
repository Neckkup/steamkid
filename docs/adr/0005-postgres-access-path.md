# ADR 0005 — How Postgres is reached

- **Status:** accepted
- **Date:** 2026-09-22
- **Decided by:** CTO
- **Issue:** PRO-70
- **Amends:** [ADR 0003](0003-managed-postgres-provider.md) — which named the right
  provider and then described a deployment that does not exist. See the correction
  note at the top of that file.

## Decision

The application database is a **managed Supabase project in Singapore
(`ap-southeast-1`)**, reached over the **IPv4 Supavisor pooler**.

`supabase.homekup.com` is **retired as an application-database path**. It is never
the host in `DATABASE_URL` or `DIRECT_URL`, and no migration is ever run against it.

Because the runner has no IPv6 route (measured below), the two connection strings
are not the ones Supabase shows first in its dashboard:

| Variable | Endpoint | Port | Mode | Login role |
| --- | --- | --- | --- | --- |
| `DATABASE_URL` | `aws-0-ap-southeast-1.pooler.supabase.com` | 6543 | transaction, append `&pgbouncer=true&connection_limit=1` | `steamkid_runtime.<project-ref>` |
| `DIRECT_URL` | `aws-0-ap-southeast-1.pooler.supabase.com` | 5432 | session — this is what `prisma migrate deploy` uses | `steamkid_migrate.<project-ref>` |

**Two roles, not one** — see "The roles" below. The `aws-0` prefix is measured, not
guessed: `aws-1-ap-southeast-1` resolves and accepts TCP but answers
`tenant/user postgres.<ref> not found`, so a reachability test alone does not tell
you which pooler is yours.

Both carry **`uselibpqcompat=true&sslmode=require`**, and the first half of that is
load-bearing. `pg` 8.23 — which Prisma reaches the database through, via
`@prisma/adapter-pg` — changed `sslmode=require` to mean `verify-full`. Supabase's
pooler presents a chain the runner does not trust, so a bare `sslmode=require`
now fails with `self-signed certificate in certificate chain`: an error that reads
like a networking fault and is a client-library default change. `uselibpqcompat=true`
restores libpq's meaning — encrypt, do not verify the chain.

That is the correct string for a database holding synthetic and CI data, and it is
**not** the end state. Verifying the chain needs Supabase's CA pinned via
`sslrootcert`, which is a real task rather than a flag, and it belongs with the other
work at the real-child-data gate ([PRO-16](/PRO/issues/PRO-16)): an unverified chain
means a party who can intercept the connection can read it. Recorded here so the
`uselibpqcompat` flag is never mistaken for a decision that TLS verification does not
matter.

**`db.<project-ref>.supabase.co:5432` must not be used.** That is the "direct
connection" the dashboard offers by default, and on the free tier it resolves to
IPv6 only. Our runner has no IPv6 egress, so that string fails with a routing
error that reads like an outage and is not one. This row is the single most
expensive thing in this ADR to rediscover by hand, which is why it is written down
before anyone provisions.

Every hard exclusion in ADR 0003 still holds: plain Postgres only, no Supabase
Auth, Storage, Realtime, Edge Functions, PostgREST, or `@supabase/supabase-js`.

This ADR does not touch Langfuse. Self-hosting traces (ADR 0002) rests on a
different argument about a different dataset and is decided separately in PRO-69.

## The roles

Provisioned 2026-09-23, project ref `abujfqhsddndtntdahxz`, PostgreSQL 17.6,
`ap-southeast-1`. Split into two roles the same day by
[PRO-103](/PRO/issues/PRO-103).

**The connection strings do not use the `postgres` superuser-equivalent account.**
The Supabase connection Paperclip installed grants SQL execution but deliberately
never exposes a libpq password, so rather than ask the founder to paste the
project's `postgres` password into a secret, `postgres` was used to mint dedicated
login roles. The founder's `postgres` password is never handled by an agent and
never enters a Paperclip secret.

Neither role may create roles or databases. The grants are:

| | `steamkid_migrate` | `steamkid_runtime` |
| --- | --- | --- |
| Carried by | `DIRECT_URL` (5432, session) | `DATABASE_URL` (6543, transaction) |
| Used by | `prisma migrate deploy`, and nothing else | the application, and nothing else |
| `rolsuper` / `rolcreaterole` / `rolcreatedb` | false / false / false | false / false / false |
| `CONNECT` on database `postgres` | granted | granted |
| `CREATE` on database `postgres` | **granted** | **revoked** |
| `identity`, `app`, `events`, `ml` | `USAGE, CREATE`; owner after cutover step 3 | `USAGE` only |
| `CREATE` on schema `public` | granted (`_prisma_migrations`) | revoked |
| `public._prisma_migrations` | `SELECT, INSERT, UPDATE, DELETE` | none |
| Tables in `identity`, `app`, `events` | owner after cutover step 3 | `SELECT, INSERT, UPDATE, DELETE` |
| Tables in `ml` | owner after cutover step 3 | `SELECT` only |

The "after cutover step 3" qualifiers are load-bearing. Until `REASSIGN OWNED`
runs, `steamkid_app` still owns the four schemas and all 31 tables; the migrator
reaches them through the explicit grants in §4c of `roles.sql`, not through
ownership. An earlier revision of this table stated the end state flatly and the
gap between it and the database went unnoticed — see below.

The whole point is the fourth row. `CREATE` on the *database* is what makes "no DDL"
either true or decorative: a role that can `CREATE SCHEMA` can build itself a schema
it owns and do whatever it likes inside it, so revoking `CREATE TABLE` while leaving
`CREATE SCHEMA` would have been a comfortable-sounding no-op.

Runtime keeps `UPDATE` and `DELETE` because consent withdrawal and skill state
legitimately need them. History is protected one layer up, by the append-only
triggers in the migrations — and the reason runtime cannot simply remove those
triggers is that `DROP TRIGGER` and `ALTER TABLE ... DISABLE TRIGGER` both require
table *ownership*, which runtime does not have and cannot grant itself.

### Two things that had to happen before migration 1, not after

**The four schemas are created by `scripts/sql/roles.sql`, not by migration 1.**
`ALTER DEFAULT PRIVILEGES ... IN SCHEMA` needs the schema to exist, and default
privileges only apply to objects created *afterwards*. Setting them after the first
migration would leave that migration's tables with no runtime grants at all, and the
hand-written `GRANT`s papering over it would then have to be repeated — correctly —
in every migration anyone ever writes again. The failure mode when someone forgets
is a production permission error, not a test failure. Migration 1's
`CREATE SCHEMA IF NOT EXISTS` short-circuits; its `COMMENT ON SCHEMA` still works
because the migrator owns the schemas.

**The split itself happened before any migration ran, which made it nearly free.**
This ADR originally recorded the single-role setup as a known limit to be fixed
"before the PRO-16 gate", and [PRO-103](/PRO/issues/PRO-103) was sequenced after
[PRO-68](/PRO/issues/PRO-68) for that reason. PRO-68 then sat blocked on a secret
binding that never applied, so the database was still empty when PRO-103 was picked
up — no objects to `REASSIGN OWNED`, no grants to backfill, and the default
privileges could go in ahead of the first table rather than being retrofitted around
it. The sequencing was reversed on that basis. *Irreversible-first: the cost of this
change was lowest on the day the database was empty, and only ever rises.*

**That window closed the same hour, and the retrofit arrived anyway.** Between
09:15 and 09:27 on 2026-09-23 the PRO-68 migrations were applied — as
`steamkid_app`, after a schema reset that dropped the four schemas and recreated
them under `steamkid_app` ownership. Measured from the catalog afterwards:

| | Designed | Found at 09:30 |
| --- | --- | --- |
| Owner of `identity`/`app`/`events`/`ml` | `steamkid_migrate` | `steamkid_app` |
| Owner of the 31 tables | `steamkid_migrate` | `steamkid_app` |
| `steamkid_runtime` privileges on those tables | full DML | **none, on any of them** |
| `steamkid_migrate` `CREATE` on the four schemas | yes | **no** |
| `pg_default_acl` entries from §4 of `roles.sql` | present | present, and inert |

The last two rows are the whole lesson. `ALTER DEFAULT PRIVILEGES` applies only to
objects created afterwards **by the role named in `FOR ROLE`**, so a migration run
by any other role lands entirely outside it. Nothing about the configuration looked
wrong — both roles existed, and `pg_default_acl` still read exactly as designed —
while the runtime role could not read a single row and the migrator could not
create a single table.

The security invariant survived: `steamkid_runtime` still owned nothing, so
`DROP TABLE`, `ALTER TABLE` and `DROP TRIGGER` stayed out of reach regardless of who
owned the tables. What did not survive was the runtime role's ability to do its job,
and the migrator's ability to run migration N+1.

Repaired additively in `roles.sql` §4b — explicit grants on the 31 objects that
already exist, plus the §4 defaults mirrored onto `steamkid_app` so that migrations
Backend runs *before* the cutover do not re-open the same hole one table at a time.
The ownership transfer is deliberately **not** in that repair: `REASSIGN OWNED`
would take DDL away from the role Backend is migrating with right now, which is the
same mistake as revoking `CREATE` mid-flight, made twice. It is step 1 of the
cutover sequence at the bottom of `roles.sql` instead.

### `steamkid_app` is retired

The combined DDL+DML role this ADR first shipped. It is **still fully live**: it
holds `CREATE` on the database and on `public`, owns the four schemas and all 31
tables, and is the role Backend is running migrations with today.

An earlier revision of this section said it had been stripped of `CREATE` and could
no longer run a migration. That was true for roughly ten minutes and it was the
wrong call: taking DDL from a role a teammate is actively migrating with turns a
permissions decision into what reads as a broken migration. The two `REVOKE`s have
been commented out of `scripts/sql/roles.sql` and moved into the ordered cutover
sequence at the bottom of that file, where they run *after* Backend has switched to
the migrate credential. Until then `steamkid_app` keeps working, on purpose.

**Its credential is live and currently bound to two agents — it did not stay
unheld.** Only the first binding batch (09:01, PRO-70) was auto-rejected on
`http_409`. A second batch was raised at 09:08 against the approved `secretId` and
the founder approved all four, so `steamkid/postgres/database-url` and
`steamkid/postgres/direct-url` — both carrying `steamkid_app` — are injected today
as `env.DATABASE_URL` / `env.DIRECT_URL` into **Backend** and **CTO**.

Retiring the role therefore broke two live bindings rather than none. Measured
2026-09-23 by resolving both bound secrets and connecting through the pooler:

| Bound secret | Port | Result as `steamkid_app` |
| --- | --- | --- |
| `env.DIRECT_URL` | 5432 | `CREATE TABLE public.…` → `42501 permission denied for schema public` |
| `env.DATABASE_URL` | 6543 | `CREATE TABLE public.…` → `42501 permission denied for schema public` |
| both | — | `SELECT` still succeeds; the role can connect and read, nothing more |

`public` is where `prisma migrate deploy` creates `_prisma_migrations`, so the
failure lands on its **first** statement — before any schema in this ADR is
touched. Any agent still holding these two variables gets a connection that opens
and then refuses all DDL, which reads like a broken migration rather than a
revoked grant.

Sequencing consequence: the two new bindings must be approved **and** the two
`steamkid_app` bindings revoked. Dropping the role while those bindings resolve
would turn a clear `42501` into an authentication failure against a vanished role.

### The migrator could not migrate, and two checks now say so

The `identity`/`app`/`events`/`ml` row of the table above describes the intended
end state. It was not the state of the database. The 09:17 schema reset that
handed the four schemas back to `steamkid_app` also took `CREATE` on them away
from `steamkid_migrate`, and §4b of `roles.sql` — written to repair that reset —
only restored what the **runtime** role had lost. The migrator was left holding
`CREATE` on the *database* and on none of the four schemas.

Measured 2026-09-23 by assuming the role and attempting the DDL:

| Attempted as `steamkid_migrate` | Before | After |
| --- | --- | --- |
| `CREATE TABLE app.__probe` | `42501 permission denied for schema app` | created |
| `CREATE TABLE events.__probe` | `42501` | created |
| `CREATE TABLE identity.__probe` | `42501` | created |
| `CREATE TABLE ml.__probe` | `42501` | created |
| `SELECT` on `public._prisma_migrations` | **no privilege at all** | granted |

Two things made this worth more than a one-line fix.

The first is that §3 grants the migrator `CREATE` on the four schemas *only by
owning them*, and `CREATE SCHEMA IF NOT EXISTS ... AUTHORIZATION` does not
transfer ownership of a schema that already exists. Re-running `roles.sql`
therefore could not repair it — the file was silently a no-op in exactly the
situation it existed to fix. §4c grants it explicitly instead, which is correct
before the cutover and harmless after it.

The second is where it would have surfaced. Prisma touches
`public._prisma_migrations` before anything else, so the missing grant would not
have waited for a migration: `prisma migrate status` is the command the cutover
uses as its proof that the new credential works, and it would have been the
thing that failed. The cutover switches Backend's credential (step 2) *before*
`REASSIGN OWNED` hands these privileges over (step 3), so the gap sat inside the
approved sequence. Granting both up front removes the window rather than
narrowing it.

`steamkid_runtime` is deliberately given nothing on the ledger: application code
has no business reading or rewriting migration history.

### The Supabase API roles are kept out, and that is now asserted

`anon`, `authenticated` and `service_role` are the roles PostgREST assumes for
requests arriving at the project's public REST endpoint. `anon` requires no
credential at all. None of them holds `USAGE` on `identity`, `app`, `events` or
`ml`, and none can reach a table in them.

That isolation is real but it was **incidental**, which is why it is now a
check. Supabase's own default privileges — visible in `pg_default_acl` under
grantor `postgres` — grant all three roles full `arwdDxtm` on every new table in
`public`. Our separation rests entirely on the application's tables living
outside `public`. A single `GRANT USAGE ON SCHEMA app TO anon`, or one table
created in `public` instead of `app`, would publish behaviour events to the open
internet with no authentication step in front of them.

`verify:grants` now fails if any of those three roles gains `USAGE` or any table
privilege on the four schemas, and if any table other than `_prisma_migrations`
appears in `public`.

### `GRANT` as the wrong role is a silent no-op, not an error

Applying §4b/§4c as `postgres` does nothing at all, and says so only in a
warning. `GRANT` and `REVOKE` affect solely the privileges the **issuing role
itself granted**; `steamkid_app` is the grantor of record for every privilege in
those sections, so a matching statement from `postgres` matches no ACL entry and
changes nothing. Measured 2026-09-23, both as `postgres`:

| Statement | Reported | Actual effect |
| --- | --- | --- |
| `GRANT CREATE ON SCHEMA app TO steamkid_migrate` | success | none — `nspacl` unchanged |
| `REVOKE DELETE ON app.ai_verdict FROM steamkid_runtime` | success | none — privilege still held |

Re-issued as `steamkid_app`, the owner, both took effect immediately.

This is worth writing down because it is the failure mode this ADR can least
afford: a privilege script that exits 0 while leaving the database untouched.
`postgres` holds `ADMIN` on both roles, so the fix when it is needed is `SET
ROLE` first — but the durable answer is that §4b and §4c run as the object
owner, and that the catalog, not the exit code, is what says whether they
worked. It is also the second time today that this database has reported success
for something that did not happen; both times `verify:grants` is what caught it.

### `citext` lives in `public`, on purpose

Migration 1 declares `email citext` unqualified. `citext` was absent from the fresh
project; `pgcrypto` was already present in `extensions`, so its `IF NOT EXISTS` is a
no-op. Installing `citext` into `extensions` and adding it to the role's
`search_path` was tried first **and measured to fail**: `ALTER ROLE ... SET
search_path` does not reliably reach a session through Supavisor — a probe through
the pooler still reported `"$user", public` and the column failed with
`type "citext" does not exist`.

So `citext` is installed in `public`, where the default `search_path` already looks.
This costs a Supabase `extension_in_public` advisory and buys a migration that does
not depend on pooler session state. An intermittent search_path failure behind a
transaction pooler is precisely the bug that costs days to find; the lint warning
costs nothing on a CI-only database.

## The facts this rests on

Measured from a runner on 2026-09-22, independently reproduced by CTO after
Backend first reported them in PRO-67:

| Target | Port | Result |
| --- | --- | --- |
| `supabase.homekup.com` | 443 | connected, 0.4 s — this is what answers 404 |
| `supabase.homekup.com` | 5432 | no connection within 8 s |
| `supabase.homekup.com` | 6543 | no connection within 8 s |
| `langfuse.homekup.com` | 5432 | no connection within 8 s |
| `github.com` | 22 | connected, 0.1 s — *control* |
| `aws-0-ap-southeast-1.pooler.supabase.com` | 5432 | connected, 0.1 s — *control* |
| `aws-0-ap-southeast-1.pooler.supabase.com` | 6543 | connected, 0.1 s |
| `ipv6.google.com` | 443 | `ENETUNREACH` |
| `2001:4860:4860::8888` (raw IPv6) | 53 | `ENETUNREACH` |

Three conclusions, each load-bearing:

1. **`supabase.homekup.com` has never had a TCP path to Postgres.** Its DNS points
   at Cloudflare proxy addresses (`104.21.80.47`, `172.67.174.86`). An
   orange-clouded record forwards HTTP/HTTPS and nothing else; raw 5432 needs
   Cloudflare Spectrum (Enterprise) or a grey-cloud record with the port opened on
   the host. Neither exists. **Restoring the tunnel therefore does not produce a
   database** — it produces Studio and the REST API over HTTPS, which is not what
   Prisma connects to.
2. **A control connected on 5432 to a different host.** The runner's egress is not
   the constraint. The silence is a property of the target.
3. **The runner has no IPv6 egress at all.** This is why the pooler rows above are
   in the decision and the `db.<ref>` row is excluded.

And the fact that makes this cheap to decide today rather than expensive to decide
later — from Backend's close-out of PRO-67:

> `DATABASE_URL` has only ever held the `localhost:5432` placeholder copied from
> `.env.example`. `GET /api/agents/me/secrets` → `{"secrets":[]}`, and PRO-12's
> inventory records `appliedBindingConfigPath: null`.

**No binding was ever applied, so the self-hosted instance holds nothing.** There
is no dump to take, no rows to move, and no founder session needed to extract
anything. The migration cost of this decision is zero today, and it only rises.

## Why this is not a reversal of anything

ADR 0003 is the accepted decision and it already says managed Postgres from a
provider, used as a plain endpoint. Nobody ever ratified an application database on
the founder's machine — that was drift, and PRO-67 showed it was drift that was
never even wired up. So this ADR executes ADR 0003 as written; it does not overturn
it.

It also does not overturn the founder's 19 Sep call to put Langfuse on the same box
as Supabase rather than renting a second machine. That decision was about where
*Langfuse* runs, and it stands or falls on PRO-69.

## Rejected alternatives

**Grey-cloud the DNS record and open 5432 to the internet.** Rejected, and this one
is not close. The mitigation that would make it survivable is an IP allowlist, and
we cannot write one: Paperclip runner egress addresses are ephemeral and not
knowable in advance, and Vercel's are a large shared pool. The allowlist would
therefore have to be `0.0.0.0/0`. That is a database designed to hold children's
work sitting on the open internet behind a password, on a host we do not patch,
cannot log into, and cannot read the auth log of. It also fails on its own terms —
it still needs a founder session on the machine, so it does not even buy speed over
the option we chose. *Blast radius of children's data.*

**Cloudflare Tunnel in TCP mode (`cloudflared access tcp`).** Rejected as the
primary path, kept as the fallback. The security posture is genuinely good: no
inbound port, an Access policy, a service token. It fails on reachability, not on
safety:

- It still needs a founder session on the machine to add the route — which is the
  exact wait we are trying to end. It unblocks nothing this week.
- Every client needs the `cloudflared` binary plus a token. The runner has no
  `cloudflared` (verified), and a Vercel build or serverless function cannot run a
  sidecar next to Prisma. So production would still need a second, different access
  path, and we would be maintaining two ways into one database.
- It depends on Cloudflare account access we do not have. PRO-69's first ask is
  "please press Connect for Cloudflare", still unanswered.

If the founder rules that the data must stay on `homekup.com`, this becomes the
decision and the first two bullets become the cost of that ruling.

**Cloudflare Spectrum.** Rejected: raw TCP on an arbitrary port is an Enterprise
feature. Buying an Enterprise contract to reach a free-tier development database is
not a sentence that survives being read aloud, and spend is CEO's call regardless.

**Wait for PRO-69 to resolve first.** Rejected. PRO-69 is about where Langfuse
lives and needs the founder. This needs a connection card and nothing else, and
PRO-68 has been blocked on a connection string the whole time. Coupling them makes
the database wait on an unrelated human decision for no gain.

## Migration cost if we are wrong

| If wrong about | Cost to change |
| --- | --- |
| Supabase as the managed host | **Low, and lowest it will ever be.** Zero rows exist today. Later: `pg_dump` → `pg_restore`, swap two env vars, redeploy. ADR 0003's re-decision trigger is unchanged. |
| The pooler endpoints | **Very low.** Two env vars. If the project ever gets IPv6 egress or the IPv4 add-on, the direct string becomes usable; nothing in the code changes either way. |
| Retiring `supabase.homekup.com` | **Low.** Nothing points at it. If the founder overrules, the fallback is the Cloudflare Tunnel option above, at the cost of a second access path for production. |
| Splitting migrator from runtime | **Paid, and it was near-zero.** Done while the database held no objects: nothing to `REASSIGN OWNED`, no grants to backfill. The same change after the first migration costs an ownership transfer plus a grant sweep, and after real child data it costs that during a maintenance window. Reverting is one `GRANT CREATE` and a secret rotation. |
| `uselibpqcompat=true` instead of a pinned CA | **Low, and deliberately deferred.** Adding `sslrootcert` is a flag plus shipping Supabase's CA. It must be paid before real child data; until then the database holds synthetic and CI rows only. |
| The hard exclusions from ADR 0003 | **High if violated.** Unchanged, and still the line to defend in review. |

## What this deliberately does not decide

- **Langfuse hosting.** PRO-69, founder's call.
- **The real-child-data gate.** Unchanged and still shut. The free tier has no PITR,
  so it carries synthetic and CI data only. [PRO-16](/PRO/issues/PRO-16) — a backup
  that has been restored at least once — still blocks any real child data, and so
  does ADR 0003's requirement that the provider be re-decided at that gate.
- **The provider at the PITR gate.** Neon remains the leading candidate on price.
  Re-verified 2026-09-22: it is still absent from the Paperclip connections catalog,
  so adopting it still costs a human credential session. That trade is re-run at the
  gate, not now.

## Verification

The check that proves this ADR, in order:

1. TCP connect from a runner to the Singapore pooler on 5432 and 6543 — **done
   2026-09-22, both connected in 0.1 s.** This is the step that distinguishes this
   decision from the one it replaces: the endpoint was proven reachable *before* it
   was written down.
2. Founder accepts the Supabase connection card; project created in
   `ap-southeast-1`; `DATABASE_URL`/`DIRECT_URL` issued as Paperclip secrets in the
   shape tabled above. They never enter the repo. — **done 2026-09-23.** Card
   accepted; project `abujfqhsddndtntdahxz` live on PostgreSQL 17.6; both URLs
   raised as secret proposals plus bindings to Backend and CTO, pending approval.
3. The credential is sufficient for the migrations we actually have — **done
   2026-09-23**, and it was not sufficient on the first attempt. Verified as
   `steamkid_app` through the pooler:

   | Check | Result |
   | --- | --- |
   | Authenticate on 5432 and 6543 | `current_user = steamkid_app` on both |
   | `prisma migrate status` | reads state, reports the 4 migrations pending |
   | `CREATE EXTENSION IF NOT EXISTS citext` / `pgcrypto` | both short-circuit |
   | `CREATE SCHEMA` | ok — needed the database-level `CREATE` grant |
   | `email citext` unqualified + case-insensitive `UNIQUE` | ok, duplicate rejected `23505` |
   | `CREATE VIEW`, `CREATE FUNCTION`, `CREATE TRIGGER` | ok |
   | `db.<project-ref>.supabase.co:5432` | `ENETUNREACH` — the excluded row, now measured |

   The probe ran in a throwaway `_cto_probe` schema and dropped it; the database is
   still empty, so PRO-68 starts from zero.
4. The role split is real and not merely documented — **done 2026-09-23**,
   [PRO-103](/PRO/issues/PRO-103). `npm run verify:roles`
   (`scripts/verify-db-roles.ts`) connects as both roles against the live database
   and asserts 13 checks. It is written to fail, and it did: the first run reported
   two genuine failures, because each check ran in its own rolled-back transaction,
   so `UPDATE` met an empty table and a `FOR EACH ROW` trigger never fired —
   success over zero rows, which reads exactly like a missing guard. The migrator
   now commits a fixture row first, and the script refuses to run if that row is
   not visible to the runtime role.

   | The runtime role tries | Result |
   | --- | --- |
   | `INSERT`, `SELECT` on a migrator-created table | allowed — the positive control |
   | `UPDATE`, `DELETE` | refused by the append-only trigger, *not* by privileges |
   | `DROP TABLE`, `ALTER TABLE ... ADD COLUMN` | `42501` |
   | `DROP TRIGGER`, `ALTER TABLE ... DISABLE TRIGGER` | `42501` |
   | `CREATE TABLE` in `events` and in `identity` | `42501` |
   | `DROP SCHEMA events`, `CREATE SCHEMA` | `42501` |
   | `TRUNCATE` | `42501` |

   Three details are what make this evidence rather than ceremony. A privilege
   denial only counts as `42501`, so a typo that raised `undefined_table` cannot be
   read as a refusal. The two trigger checks *fail* if they get `42501`, because
   being stopped by privileges would mean the trigger was never reached and the
   append-only guarantee went untested. And the fixture lives in `events` rather
   than a scratch schema, so it exercises the real `ALTER DEFAULT PRIVILEGES` path
   — a probe schema would pass while the actual grants were broken.
5. The grants hold for every object that exists, not a sample — **done
   2026-09-23**. `npm run verify:grants` (`scripts/verify-db-grants.ts`) reads the
   catalog rather than probing behaviour, which buys three things `verify:roles`
   cannot give. It runs on **one** credential with no special rights, so the split
   stays checkable during the window where the two new secrets are still awaiting
   approval and nobody holds both. It covers **all 31 tables** instead of one
   fixture. And it asserts the `ml` projection is read-only — the control that
   stops application code writing to consent-filtered training data, which
   `verify:roles` never touched.

   It is written to fail, and was made to. Against the live database, revoking
   `INSERT` on one table in `app` and granting `INSERT` on one table in `ml`:

   ```
   FAIL  steamkid_runtime has full DML on all 18 table(s) in app — 1 without it: ai_verdict
   FAIL  steamkid_runtime cannot write to ml — WRITABLE: training_export_run
   26/28 checks passed          (exit 1)
   ```

   Both grants were restored and the run returned to 28/28, exit 0. The two checks
   worth naming: `steamkid_runtime owns nothing`, which is the append-only
   guarantee in one query since `DROP`/`ALTER`/`DROP TRIGGER` require ownership and
   ownership cannot be granted; and *"a new table created by X in Y reaches
   `steamkid_runtime`"*, evaluated per role that currently owns objects — the check
   that catches a migration applied by a role the default privileges were not
   written for, which is exactly how the 09:17 regression above went unnoticed.
6. The migrator can migrate, and PostgREST cannot reach the data — **done
   2026-09-23**, ten further checks in `verify:grants` (38 total). These close
   two gaps the first 28 did not look at.

   Checks 5 asked only where a new table *lands*, never whether the migrator
   could create one; the answer was no, on all four schemas, and on Prisma's
   ledger it held nothing at all. Checks 8 assert that `anon`, `authenticated`
   and `service_role` hold no `USAGE` and no table privilege on the four
   schemas, and that nothing but `_prisma_migrations` sits in `public` — the one
   schema where Supabase's defaults publish new tables to the open REST
   endpoint automatically.

   Four of the new checks were made to fail against the live database — revoking
   the migrator's `CREATE` on `events`, granting `anon` `USAGE` on `app`,
   revoking the migrator's `SELECT` on the ledger and granting the runtime role
   one:

   ```
   FAIL  steamkid_migrate can create in events — 42501 on the next migration — CREATE on the database is not enough
   FAIL  anon cannot reach the application schemas — EXPOSED — USAGE on app
   FAIL  steamkid_migrate can use Prisma's migration ledger — missing SELECT — prisma migrate status fails before any migration runs
   FAIL  steamkid_runtime cannot touch Prisma's migration ledger — REACHABLE: SELECT
   ```

   Each was restored and the run returned to 38/38, exit 0. The fifth new check,
   *"no application table sits in `public`"*, could not be fault-injected: no
   role we hold can create there — `steamkid_app` lacks `CREATE` on `public`
   and only `steamkid_migrate` has it. That inability is the finding, not a gap
   in the proof.
7. `prisma migrate deploy` applies all four migrations unedited as
   `steamkid_migrate`, and `/api/health` reports `database: true` —
   [PRO-68](/PRO/issues/PRO-68), Backend, once the new bindings are live.

   The statements that migration 1 opens with were dry-run as the migrator
   earlier on 2026-09-23 and all succeeded. **That result expired the same day**
   and is kept here as a caution rather than as evidence: it was measured while
   the migrator still owned the four schemas, and the 09:17 reset took that
   ownership — and with it the `CREATE` the dry-run depended on — away. Re-run
   as the migrator afterwards, every one of those `CREATE`s returned `42501`.
   A verification of a privilege is only true as of the moment it ran, which is
   the argument for `verify:grants` existing at all.
