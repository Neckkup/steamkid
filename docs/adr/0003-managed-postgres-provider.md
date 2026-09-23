# ADR 0003 — Managed Postgres provider

- **Status:** accepted (staged — see "Re-decision trigger"), amended by [ADR 0005](0005-postgres-access-path.md)
- **Date:** 2026-09-18
- **Decided by:** CTO
- **Issue:** PRO-12
- **Supersedes:** the `provider TBD` cell in [ADR 0001](0001-stack.md)

> **Correction, 2026-09-22 (PRO-70, first flagged in PRO-16).** Everywhere below,
> "Supabase" means **Supabase's managed service**. It never meant the self-hosted
> Supabase that appeared at `supabase.homekup.com` on the founder's machine. That
> host was drift, not a decision recorded here, and PRO-67 established it was never
> wired to anything: `DATABASE_URL` only ever held the `.env.example` placeholder.
>
> `supabase.homekup.com` is also structurally unusable as an application database —
> its DNS is an orange-clouded Cloudflare record, which forwards HTTP/HTTPS and
> never raw 5432. [ADR 0005](0005-postgres-access-path.md) records that finding, the
> exact connection-string shape to use, and why the obvious one in the Supabase
> dashboard does not work from our runners.

## Decision

Host the application Postgres on **Supabase**, used as a **plain Postgres endpoint
only**, starting on the free tier.

The database is reached exactly one way: `DATABASE_URL` / `DIRECT_URL` consumed by
Prisma through the `pg` driver adapter, as `src/lib/env.ts` already defines. That is
the whole integration surface.

**Hard exclusions.** We do not adopt Supabase Auth, Supabase Storage, Realtime,
Edge Functions, PostgREST, or `@supabase/supabase-js`. None of these may enter
`package.json`. Auth stays Auth.js per ADR 0001.

**Region.** The project is created in Southeast Asia (Singapore, `ap-southeast-1`).
Region is fixed at project creation and cannot be changed afterwards, so this is
decided before the project exists, not after.

## Why

**This is not the Supabase that ADR 0001 rejected.** ADR 0001 rejected the Supabase
*bundle* — "auth and the database would be coupled to one vendor exactly where our
data is most sensitive", and the behaviour-event and export paths "fit into someone
else's abstractions". That reasoning is about Supabase Auth, Supabase Storage, and
the PostgREST/RLS programming model. It is not about who runs the Postgres process.
ADR 0001's own conclusion was "We keep plain Postgres, which any provider can host."
Supabase is one of the providers that can host it. The hard exclusions above are what
keep that sentence true, and they are the load-bearing part of this ADR.

**It is the only Postgres host an agent can provision without a human console
session.** Supabase is in the Paperclip connections catalog with OAuth and API-key
methods. Neon, Vercel Postgres, and RDS are not. Every deliverable on
[PRO-12](/PRO/issues/PRO-12) that is still open is stalled on exactly this — a human
has to go create an account by hand. Choosing the provider that removes a human step
is worth more right now than a marginally better pricing table later, because the
pricing difference only starts mattering at a point we have not reached.

**Plain Postgres is what makes this cheap to get wrong.** Because the integration
surface is one connection string and Prisma migrations, the provider is a
swap, not a rewrite. That is what licenses deciding now on incomplete information
rather than waiting.

## Re-decision trigger

**This decision is revisited before the first row of real child data lands**, on the
same ticket that turns on PITR. That is not a vague "later" — it is the gate already
written into [PRO-12](/PRO/issues/PRO-12) and the spend approval: *region pinned and
point-in-time recovery on, before any real child data exists.*

The reason it must be revisited is a cost fact that cuts against Supabase at exactly
that gate:

| Provider | Free tier | Paid tier we would need | PITR |
| --- | --- | --- | --- |
| Supabase | 500 MB, no PITR | Pro ≈ USD 25/mo | PITR is a **paid add-on**, ≈ USD 100/mo on top |
| Neon | 0.5 GB, no PITR | Launch ≈ USD 19/mo | history retention **included** in the tier |

So Supabase is the cheaper way to get moving today and, on today's public pricing,
the markedly more expensive way to hold regulated children's data with PITR. Both
of those are true at once, and the staged decision is the honest response: take the
unblock now, pay the switch cost later if the numbers still look like this. Do not
read this ADR as "steamkid runs on Supabase forever."

Neither free tier may hold real child data. Free tier is for preview, CI, and
schema work only.

## Rejected alternatives

**Neon.** Better pricing at the PITR gate and a genuinely nicer branching model for
per-PR preview databases. Rejected *for now* only because it is not in the
connections catalog, so adopting it today means a human creating an account and
minting a token by hand — the exact blocker this decision exists to remove. Neon is
the leading candidate at the re-decision trigger above.

**Vercel Postgres / Neon-via-Vercel.** Rejected: it does not remove the human step
(we have no Vercel credentials either — see PRO-12), and it binds the database's
lifecycle to the deploy platform, which ADR 0001 deliberately kept at "Low" migration
cost.

**Postgres in Docker on the same VM as Langfuse.** Rejected. It saves roughly USD 0
— the VM is already approved and paid for — but it puts children's application data
on a box we patch ourselves, with backups we write ourselves, sharing a failure
domain with the observability stack. ADR 0002 accepted self-hosting for *traces*
because sending them to a SaaS was the greater privacy harm. No such forcing
argument exists for the application database, so the "buy before build" lens applies
normally.

**Staying on `provider TBD`.** Rejected: it is the status quo and it is what is
holding the preview URL hostage.

## Migration cost if we are wrong

| If wrong about | Cost to change |
| --- | --- |
| Supabase as the host | **Low**, and deliberately so. `pg_dump` → `pg_restore`, swap `DATABASE_URL`/`DIRECT_URL` in the deploy env, redeploy. Hours, not days, and it stays low only as long as the hard exclusions hold. |
| The hard exclusions | **High if violated.** Adopting Supabase Auth or Storage is what converts the row above from "swap a connection string" into the vendor coupling ADR 0001 rejected. This is the line to defend in review. |
| Singapore region | High. Region is immovable after project creation; changing it is a full migration to a new project. |
| Free tier for pre-production | Low, provided the "no real child data" rule holds. |

## Consequences

- `DATABASE_URL` and `DIRECT_URL` are proposed as Paperclip secrets and injected into
  the deploy environment. They never enter the repo. Supabase's pooled connection
  string maps to `DATABASE_URL`; the direct (unpooled) one to `DIRECT_URL`, which is
  what Prisma migrations need.
- `/api/health` reports `database: true` once these are set — one of the PRO-12 done
  criteria.
- A follow-up ticket owns the production hardening gate: region pinned, PITR on,
  provider re-decided per the trigger above. That ticket blocks any real child data.
