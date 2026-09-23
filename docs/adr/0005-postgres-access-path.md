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

| Variable | Endpoint | Port | Mode |
| --- | --- | --- | --- |
| `DATABASE_URL` | `aws-<n>-ap-southeast-1.pooler.supabase.com` | 6543 | transaction, append `?pgbouncer=true&connection_limit=1` |
| `DIRECT_URL` | `aws-<n>-ap-southeast-1.pooler.supabase.com` | 5432 | session — this is what `prisma migrate deploy` uses |

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
   shape tabled above. They never enter the repo.
3. `prisma migrate deploy` applies all three migrations unedited, and
   `/api/health` reports `database: true` — [PRO-68](/PRO/issues/PRO-68).
