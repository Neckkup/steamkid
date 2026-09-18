# steamkid

STEAM learning for children. AI grades the work, tracks each child's behaviour and
growth, personalises the learning path, and builds the dataset we will later use to
train our own model.

## Rules that apply to every change

1. **Every AI call is traced.** Call the LLM through `traceAiCall()` in
   `src/lib/observability/langfuse.ts`. A feature that reaches a model outside that
   wrapper is not finished.
2. **No child's identity leaves our infrastructure.** Everything bound for Langfuse
   or Sentry goes through `src/lib/privacy/redact.ts` first. Use the pseudonymous
   `learnerRef`, never a name, email, photo, or raw free-text answer.
3. **No secrets in the repo.** Keys arrive through Paperclip secret proposals or the
   host's environment settings. `.env.example` lists the names, never the values.
4. **Event history is append-only.** Add a new row and bump `payloadVersion`; never
   mutate a past event in place.

## Run it locally

Requires Node 20.11+ and, for anything database-backed, a local Postgres.

```bash
npm install
cp .env.example .env.local     # fill in what you need; most vars are optional
npx prisma generate
npm run dev                    # http://localhost:3000
```

The app boots with no database, no Langfuse, and no Sentry — the landing page and
`/api/health` report which integrations are configured. That is deliberate: a fresh
clone must never be blocked on credentials.

With a local Postgres running:

```bash
npm run db:migrate:dev         # create/apply migrations
```

### Local Langfuse

Langfuse is self-hosted (see [ADR 0002](docs/adr/0002-observability-and-privacy.md)).
Until the shared instance exists, run it locally with the project's official
Docker Compose stack:

```bash
git clone https://github.com/langfuse/langfuse.git ../langfuse
docker compose -f ../langfuse/docker-compose.yml up -d   # http://localhost:3000
```

Create a project in that UI, then put its keys and `LANGFUSE_BASEURL` in
`.env.local`. **Do not point steamkid at Langfuse Cloud**, not even in development.

## Scripts

| Command              | What it does                                        |
| -------------------- | --------------------------------------------------- |
| `npm run dev`        | Dev server                                          |
| `npm run build`      | Production build (fails on type errors)             |
| `npm start`          | Serve the production build                          |
| `npm run typecheck`  | `tsc --noEmit`                                      |
| `npm run lint`       | ESLint                                              |
| `npm test`           | Vitest unit tests                                   |
| `npm run db:generate`| Regenerate the Prisma client                        |
| `npm run db:migrate` | Apply migrations (deploy)                           |

## Deploying

CI (`.github/workflows/ci.yml`) runs lint, typecheck, tests, and a build on every
pull request, plus a secret scan that fails if a credential-shaped string is
committed. CI runs **without** any secret, so a fork or fresh clone is never blocked.

Deploy target: Vercel, connected to the GitHub repo.

- `main` → production
- every pull request → its own preview URL
- rollback: promote the previous deployment in the Vercel dashboard, or revert the
  commit on `main`

`APP_ENV` must be `preview` or `production` on deployed environments.
`assertObservabilityReady()` refuses to run a deployed tier without Langfuse keys.

### Environment variables

Names and purpose are documented in `.env.example`. Values are injected by the host;
they are never committed and never pasted into an issue comment.

| Variable | Where it is needed |
| --- | --- |
| `APP_ENV`, `APP_URL` | all deployed environments |
| `DATABASE_URL`, `DIRECT_URL` | runtime + migrations |
| `AUTH_SECRET` | runtime |
| `ANTHROPIC_API_KEY` | server only |
| `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASEURL` | runtime |
| `NEXT_PUBLIC_SENTRY_DSN` | runtime (public by design) |
| `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN` | build only, source-map upload |

## External dashboards

| Tool | Purpose | URL |
| --- | --- | --- |
| Vercel | deploys, preview URLs, rollback | _pending account connection_ |
| Langfuse | AI traces, prompts, evals | _pending self-host deploy — see `docs/runbooks/langfuse-self-host.md`_ |
| Sentry | web app errors | https://project-qq.sentry.io/projects/steamkid/ |

Update this table the moment an account exists. The team references these URLs
instead of asking each other where things live.

Sentry slugs, for `SENTRY_ORG` / `SENTRY_PROJECT`: org `project-qq`, project
`steamkid`. These are identifiers, not credentials. The DSN and the build-time
auth token live in the Paperclip vault (`steamkid/sentry/*`) and are injected
into the deploy environment — never committed here.

## Layout

```
src/app/                    routes (App Router)
src/app/api/health/         deployment self-check, safe to call publicly
src/lib/env.ts              validated configuration, the only reader of process.env
src/lib/db.ts               Prisma client
src/lib/privacy/redact.ts   PII redaction — the choke point for external services
src/lib/observability/      Langfuse wrapper + Sentry scrubbing
prisma/schema.prisma        data model (domain tables land in PRO-3 / PRO-7)
docs/adr/                   architecture decisions and what we rejected
```

## Decisions

- [ADR 0001 — Stack](docs/adr/0001-stack.md)
- [ADR 0002 — Observability and children's privacy](docs/adr/0002-observability-and-privacy.md)
