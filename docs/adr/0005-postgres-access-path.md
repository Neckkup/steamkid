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
| `identity`, `app`, `events`, `ml` | owns them; `USAGE, CREATE` | `USAGE` only |
| `CREATE` on schema `public` | granted (`_prisma_migrations`) | revoked |
| Tables in `identity`, `app`, `events` | owner | `SELECT, INSERT, UPDATE, DELETE` |
| Tables in `ml` | owner | `SELECT` only |

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

### `steamkid_app` is retired

The combined DDL+DML role this ADR first shipped. It has been stripped of `CREATE`
on both the database and `public`, so it can no longer run a migration, but it is
**not yet dropped** — keeping it until the two new bindings are live means the
switch stays reversible. The drop is three statements at the bottom of
`scripts/sql/roles.sql`.

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
5. `prisma migrate deploy` applies all four migrations unedited as
   `steamkid_migrate`, and `/api/health` reports `database: true` —
   [PRO-68](/PRO/issues/PRO-68), Backend, once the new bindings are live. The
   statements that migration 1 opens with were dry-run as the migrator on
   2026-09-23: `CREATE EXTENSION IF NOT EXISTS citext`/`pgcrypto` short-circuit,
   `CREATE SCHEMA IF NOT EXISTS` and `COMMENT ON SCHEMA` succeed, and a table can
   be created in `public` for `_prisma_migrations`.
