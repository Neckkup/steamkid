# ADR 0009 — What QA gets access to

- **Status:** accepted
- **Date:** 2026-09-24
- **Decided by:** CTO
- **Issue:** PRO-127 (raised by QA during the PRO-11 verification round)
- **Related:** [ADR 0002](0002-observability-and-privacy.md) (self-hosted Langfuse),
  [ADR 0005](0005-postgres-access-path.md) (the two Postgres roles)

## Context

QA could verify that steamkid **degrades correctly** with no database, no
`GEMINI_API_KEY` and no Langfuse keys, and nothing else. Three of the six
acceptance items on PRO-11 — AI grading quality, the "every AI call has a
Langfuse trace" gate, and consent plus behaviour capture — need a working
environment, and QA had none. Nobody had yet watched a behaviour event travel
from a real browser into a real table.

That last gap is the one that matters most, because of the rule the company runs
on: **data you do not capture from your first user is gone forever.** The day the
first child arrives is the day that path has to have already been proven, and
"the client code looks right" is not proof.

The obvious move is to hand QA the team's credentials. This ADR is mostly about
why we do not.

## Decision

**QA gets a disposable Postgres of its own, and read-capable access to the two
external services it cannot self-host.** Specifically:

| What | Answer | How |
| --- | --- | --- |
| Postgres | **No shared credential.** A throwaway local cluster instead. | `npm run db:local` (this ADR ships it) |
| Gemini | **Yes**, the team key | Paperclip binding `env.GEMINI_API_KEY` |
| Langfuse | **Yes**, the team keys, writing to a **separate environment** | bindings + `LANGFUSE_TRACING_ENVIRONMENT=qa` |

### Postgres: a throwaway cluster, not a credential

`scripts/local-postgres.sh` starts PostgreSQL 17 from the `embedded-postgres`
npm package — real server binaries — on port 55432, applies all five migrations,
seeds the 39-event registry and creates the partitions. `npm run db:local:reset`
deletes it.

This is strictly better for QA than the shared database would have been, which
is the part worth arguing with:

1. **`events.behavior_event` is append-only by construction**, with triggers that
   refuse an `UPDATE` or a `DELETE`. QA's stated plan is empty submissions,
   emoji-only answers, prompt injection and mashing the submit button. On the
   shared database that garbage would be *permanent*, mixed into the exact table
   whose eventual export is the company's product. There is no cleanup path,
   because we deliberately built one that cannot be cleaned.
2. **Isolation is total rather than partial.** A separate schema or a separate
   role in the same project still shares a connection pooler, a disk and a
   backup. A separate cluster shares nothing.
3. **Fresh per round.** QA can prove a migration applies to an empty database,
   which is the thing a deploy actually does and which no shared database can
   demonstrate twice.

The cluster runs as **one role**, not the `steamkid_runtime` / `steamkid_migrate`
split of ADR 0005. The split exists so the deployed app cannot drop a table; a
database you delete with one command has nothing to protect, and a fake split
would have QA testing a grant matrix production does not run. `npm run
verify:roles` and `npm run verify:grants` remain the checks for the real thing,
and they still need the real database — they are Ops/Backend checks, not QA's.

### Langfuse: same project, separate environment

Langfuse has first-class environment separation and `src/lib/env.ts` already
exposes it as `LANGFUSE_TRACING_ENVIRONMENT`. QA sets `qa`; every trace, span
and score from a QA pass is then tagged, filterable, and excluded from the
dashboards that describe real traffic. QA can open its own traces and sign or
refuse item 3 on evidence instead of on someone's word.

A separate Langfuse **project** was not needed to get that, and would have cost a
second set of keys to rotate.

### Gemini: the same key

Cost per graded item is the lens, and a QA round is dozens of items, not
millions. A second key would have bought a cleaner billing line and nothing else.
If QA's usage ever stops being negligible, split the key then — that is a
one-binding change, not a design change.

## Rejected alternatives

**Give QA `DATABASE_URL` / `DIRECT_URL` for the shared Supabase project.** What
QA asked for first. Rejected on blast radius: see the three points above. The
append-only guarantee means adversarial QA traffic against the shared database is
a one-way door, and a QA round is *specifically* the activity that generates
adversarial traffic. QA's own offer to stay read-only would have solved the
safety problem by removing the ability to test items 2 and 4 at all.

**A dedicated Supabase project or branch for QA.** The right shape, wrong price.
A Supabase preview branch bills hourly, and a second free project is founder
spend and a founder account action; neither is justified when a local cluster is
free, faster, and more isolated. Revisit if QA ever needs to test something
genuinely pooler-specific — Supavisor's transaction mode and its self-signed
certificate chain are real behaviours a local server does not reproduce. Today
nothing on PRO-11 depends on those.

**PGlite over a socket.** PGlite is already a devDependency and already builds
this exact schema from the migrations, so reusing it was tempting. It serves one
connection at a time. QA's rapid-submit case would queue behind itself and
produce timeouts that look like product bugs and are not — the worst possible
failure mode for a verification round. PGlite stays where it belongs, in
`src/lib/db/test-database.ts`.

**Tell QA the items cannot be tested.** QA offered this honestly and it was the
correct thing to offer. It is not an acceptable outcome: "the site works with no
problems" is the founder's definition of done, and three unverified items against
that definition is a release we could not defend.

## Consequences

- QA can close PRO-11 items 2, 3 and 4 on evidence.
- One new devDependency, `embedded-postgres`, carrying ~37 MB of
  platform-specific binaries as an optional dependency. It is dev-only and never
  reaches a deploy.
- The binaries are materialised by a postinstall hook. npm 11 defers install
  scripts until approved, so `local-postgres.sh` runs the hydrator itself rather
  than failing with an empty `native/bin`.
- The cluster listens on TCP only, with `unix_socket_directories` empty. A Unix
  socket path is capped at 107 bytes by the kernel, and a Paperclip workspace
  checkout is ~121 bytes before `/.local-postgres/.s.PGSQL.55432` is appended, so
  putting the socket beside the data directory — which is what the first version
  of the script did — makes Postgres refuse to start in every agent workspace.
  `pg_ctl` reports only "could not start server. Examine the log output," naming
  no log. Nothing in this repo dials the socket; do not add `-k` back.
- `.env.example`'s local Postgres placeholders were **wrong before this change**
  and are corrected here: without `?sslmode=disable`,
  `src/lib/db/pg-connection.ts` demands TLS from a local server that does not
  offer it. Migrations apply anyway, so the failure surfaces only once the app
  tries to connect — the PRO-68 split, in miniature.

## If we are wrong

The cost of reversing is small and bounded, which is why this was decided rather
than escalated.

- If QA turns out to need the real pooler, we buy a Supabase branch and bind its
  URLs to QA. Nothing here has to be undone; `db:local` stays useful for
  everyone else.
- If sharing one Gemini key or one Langfuse project becomes a problem, both are
  single-binding swaps.
- If `embedded-postgres` is a maintenance burden, deleting the script and the
  devDependency touches nothing that ships.

The one thing this ADR deliberately makes hard to reverse is handing the shared
database to an adversarial test pass. That door should stay shut.
