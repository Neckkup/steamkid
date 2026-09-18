# ADR 0001 — Stack

- **Status:** accepted
- **Date:** 2026-09-18
- **Decided by:** CTO
- **Issue:** PRO-4

## Decision

| Layer | Choice | Version at time of writing |
| --- | --- | --- |
| Framework | Next.js, App Router, TypeScript strict | 16.3.5 |
| Styling | Tailwind CSS | v4 |
| Database | Postgres | managed; provider in [ADR 0003](0003-managed-postgres-provider.md) |
| ORM / migrations | Prisma with the `pg` driver adapter | 7.10 |
| Auth | Auth.js (`next-auth` v5) + `@auth/prisma-adapter` | 5.0 beta |
| AI provider | Anthropic (external API) | — |
| AI observability | Langfuse | see ADR 0002 |
| Error tracking | Sentry | see ADR 0002 |
| Tests | Vitest | 4 |
| CI | GitHub Actions | — |
| Deploy | Vercel, git-connected | — |

One repository, one app. No monorepo, no separate API service.

## Why

**Buy before build.** Auth, error tracking, LLM inference, deploy, and preview
environments are all bought. We build only the grading engine, the behaviour
pipeline, the learning path, and the dataset — the four things that are actually
our advantage. Everything in the table above except those four is a commodity.

**One deployable.** An MVP with a separate backend service buys us independent
scaling we do not need and costs us a second deploy pipeline, a second set of
secrets, and a network hop on every request. Next.js route handlers and server
actions cover the API surface. If the behaviour-event ingest later needs to scale
independently, it is extracted as its own service — that is a contained change,
because the pipeline sits behind its own module boundary from day one.

**Postgres, not a document store.** The growth definition is relational: skills,
submissions, verdicts, corrections, and consent all join. Behaviour events are
append-only rows with a versioned JSON payload, which Postgres handles fine at
our scale, and a training-set export is a SQL query rather than a migration
project.

**Prisma 7 with driver adapters.** Prisma 7 moved connection URLs into
`prisma.config.ts` and requires an explicit driver adapter (`src/lib/db.ts`).
That is extra ceremony over Prisma 6, but pinning a new project to the previous
major means paying the same migration later with more tables in the way.

## Rejected alternatives

**Next.js + a separate NestJS/FastAPI backend.** Rejected: two deploys, two secret
sets, and a contract to maintain between them, in exchange for scaling we do not
need before we have users. Reversible — extracting a service later is ordinary work.

**Supabase (Postgres + auth + storage in one).** Genuinely tempting for speed. Rejected
because auth and the database would be coupled to one vendor exactly where our data
is most sensitive, and because the behaviour-event and export paths are the parts we
least want to fit into someone else's abstractions. We keep plain Postgres, which any
provider can host.

> Read this together with [ADR 0003](0003-managed-postgres-provider.md), which picks
> Supabase to *host* that plain Postgres. It is not a reversal: what is rejected here
> is the bundle (Supabase Auth, Storage, PostgREST, `@supabase/supabase-js`), and ADR
> 0003 excludes all of it by name. The connection string is the entire integration.

**Drizzle instead of Prisma.** Lighter and closer to SQL, but Prisma's migration
tooling and generated types are what keeps four agents editing one schema without
breaking each other. Reversible at moderate cost while the schema is small.

**Rolling our own auth.** Never. Session handling for children's accounts is exactly
the code we do not want to be the authors of.

## Migration cost if we are wrong

| If wrong about | Cost to change |
| --- | --- |
| Next.js as the app framework | High. Full rewrite of the UI and route layer. Low probability. |
| Single deployable | Low. Extract the ingest or grading path into its own service; the module boundaries already exist. |
| Prisma | Medium. Schema and migrations are portable SQL; queries are not. Grows with the codebase — decide early if at all. |
| Postgres | Very high. Treat as fixed. |
| Auth.js | Medium. Sessions and account rows would need migrating; user identity is the surrogate `Learner.id`, which is provider-independent by design, so the blast radius stops at the auth tables. |
| Vercel | Low. It is a Node app with a Dockerfile-shaped build; any host can run it. |

## Known accepted risk

`npm audit` reports high-severity advisories in `mysql2` and `deepmerge-ts`,
reached only through the **dev-only** `prisma` CLI. They are not in the runtime
dependency tree, and we do not use MySQL. Accepted; bump the CLI when Prisma
ships a patched 7.x.

## Deliberately not decided here

The skill map, the definition of "growth", and the domain schema are decided in
PRO-3. `prisma/schema.prisma` ships only the consent and pseudonymous-id
constraints, which are expensive to retrofit and independent of that design.
