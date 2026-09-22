# Runbook — Langfuse self-host

- **Status (2026-09-22): the instance is GONE.** `https://langfuse.homekup.com`
  now answers a plaintext `404 page not found` on **every** path — `/`,
  `/api/public/health`, `/api/auth/providers`, `/auth/sign-up` — served from the
  Cloudflare edge, not from Langfuse. `npm run langfuse:verify` exits 1 at the
  first gate: `FAIL [unreachable] …/api/public/health returned HTTP 404`.
  It was provisioned and answering `4.37.0` on 2026-09-19 (the v4+ requirement
  was met then) with two open hardening findings (§3). Those two findings are
  now unverifiable rather than fixed — see §3.1.
- **Owner:** CTO
- **Issue:** PRO-12
- **Why self-hosted at all:** `docs/adr/0002-observability-and-privacy.md`

This is the whole procedure. Once the VM exists it is mechanical — do not redesign
it on the day, and do not substitute Langfuse Cloud "just to unblock", because the
reason we self-host is that our traces carry children's free-text answers.

## 1. The machine

Target: **4 vCPU / 8 GB RAM / ≥80 GB disk**, Ubuntu LTS. ClickHouse is the reason
for the 8 GB; it will not run comfortably under that.

Any provider is acceptable if it meets the spec and the region is EU or
Singapore — **not** a US region, for the same reason the data does not go to a
US SaaS.

### Decision (2026-09-19): co-tenant with Supabase, not a dedicated VM

**Decided:** Langfuse runs on the existing `homekup.com` box — the same machine
that serves `supabase.homekup.com`. The founder chose this over a dedicated VM
when asked directly (PRO-26), and it is already up.

**Rejected alternative:** a dedicated Hetzner CPX31 in an EU region, ≈USD 17/mo,
which was the original recommendation here and the one the earlier draft of this
runbook assumed. It is cleaner — a compromise of the app database would not also
hand over the trace store, and ClickHouse could not starve Postgres of page
cache. It was rejected because it costs a second machine to administer and a
second security-update surface, for a team of this size and an MVP with no real
learner data in it yet.

**This overrides the earlier "Postgres must not share a box with Langfuse"
condition.** That condition was mine and it was about blast radius. The founder
took the trade knowingly; recording it here so it is argued with rather than
rediscovered.

**Migration cost if we are wrong:** moving Langfuse to its own host later is a
`docker compose down`, a volume copy (Postgres dump + ClickHouse data dir), a
DNS change, and a re-issue of `LANGFUSE_*` keys. Hours, not days, and it does
not touch app code — `LANGFUSE_BASEURL` is a single environment variable. The
expensive version of being wrong is not the migration, it is a shared-host
compromise reaching both stores at once, which is why §3 is not optional here.

**Because it is a co-tenant, these are now load-bearing and are not in the
dedicated-VM version of this procedure:**

- **Memory.** ClickHouse will take what it is given. Set an explicit
  `mem_limit` on the ClickHouse service in the compose file and leave Postgres
  its existing headroom, or the first heavy trace query degrades Supabase.
- **Disk.** Trace volume grows without asking. Alert on disk usage on this box,
  and set a Langfuse data-retention policy — a full disk takes the app database
  down with it, not just observability.
- **Ports.** Nothing in the Langfuse compose stack may publish to the host's
  public interface (§3.2). On a shared box the default `ports:` mappings can
  also collide with what Supabase already binds; use the Docker network only.
- **Backups.** The existing box's backup job was written for Supabase. Extend it
  to the Langfuse volumes, or Langfuse is silently unprotected.

### Open question — region

The region of the `homekup.com` box is **still unanswered** (asked on PRO-26,
not answered). The budget condition says EU or Singapore only. This does not
block development traces, and it does block putting a real child's free-text
answer on this instance. Get the answer before the first real learner trace.

## 2. Bring up the stack

Langfuse publishes an official Docker Compose that covers every component we need:
`langfuse-web`, `langfuse-worker`, Postgres, ClickHouse, Redis/Valkey, and
S3-compatible storage (MinIO). Use it — do not hand-assemble the services.

```bash
git clone https://github.com/langfuse/langfuse.git
cd langfuse
git checkout v4.38.0   # exact tag — see below, do not substitute
docker compose up -d
```

**The tag is `v4.38.0`, and "pin a release tag" is not sufficient instruction.**
Upstream maintains v3 and v4 *in parallel*: on 2026-09-18 the newest releases were
v4.38.0 (17 Sep) and v3.225.8 (16 Sep). Reaching for a recent-looking tag can
therefore land you on a v3 patch, which boots fine and accepts traces while
silently failing two things we have already committed to:

- **Alerting.** Langfuse's built-in alerts (Slack / webhook / GitHub Actions) are
  self-hostable only from v4, and the company rule is that we do not write our own
  alerting. On v3, none of the six alerts in `ai-observability.md` can be
  configured at all.
- **`GET /api/public/v2/metrics`**, which every widget in
  `src/lib/observability/dashboards.ts` queries.

Both failures are invisible from the ingest side. So this is enforced in code, not
trusted to whoever is at the keyboard:

```bash
npm run langfuse:verify   # exits 1 on v3, and on an un-hardened instance
```

Run it the moment the instance answers on HTTPS, and **before** any
`langfuse:prompts --push`, `langfuse:dashboards --push`, or `ai:smoke`. The check
lives in `src/lib/observability/langfuse-version.ts`; bumping
`PINNED_LANGFUSE_TAG` there and the tag above is one deliberate edit, not a drift.

**As deployed we are on `4.37.0`, not the pinned `4.38.0`.** That is inside the
v4 line, so every capability this design depends on is present and the gate
passes. Left alone deliberately rather than bumped for tidiness: upgrading
Langfuse means reading release notes for ClickHouse migrations and snapshotting
first, and there is no reason to spend that on a patch difference. Close the gap
at the next deliberate upgrade.

Before the first `up`, generate fresh values for every secret in the compose
`.env`. At minimum: `NEXTAUTH_SECRET`, `SALT`, `ENCRYPTION_KEY`, the Postgres
password, the ClickHouse password, the Redis password, and the MinIO root
credentials. **Every default that ships in the example file is a published
value and must be replaced.**

```bash
openssl rand -base64 32   # NEXTAUTH_SECRET, SALT
openssl rand -hex 32      # ENCRYPTION_KEY (must be 64 hex chars)
```

Verify the exact variable names against the Langfuse self-hosting docs for the
tag you pinned; they move between major versions.

## 3. Lock it down before it holds a single trace

> **Current state, 2026-09-19: items 1 and 4 below are FAILING on the live
> instance.** Both were found by running `npm run langfuse:verify` against it,
> and both are now enforced by that command
> (`src/lib/observability/langfuse-hardening.ts`) rather than trusted to
> whoever is at the keyboard:
>
> - **`open_signup`** — `POST /api/auth/signup` is reachable anonymously and
>   rejects only on schema validation. Anyone who finds the URL can create an
>   account on the instance that will hold our traces. Fix: `AUTH_DISABLE_SIGNUP=true`
>   once the team's accounts exist, then audit the existing user list for
>   accounts nobody recognises.
> - **`canonical_url_tls`** — `NEXTAUTH_URL` is `http://langfuse.homekup.com`.
>   TLS terminates at the edge and `http://` 301s to `https://`, so it looks
>   fine, but NextAuth keys cookie security off the configured URL, not off the
>   scheme the request arrived on. Session cookies are issued without `Secure`
>   and go on the wire on the first plaintext request, before the 301. Fix:
>   set it to the `https://` origin, restart `langfuse-web`, invalidate
>   existing sessions.
>
> Neither is visible from the ingest side, which is the whole reason they are
> checked in code. Re-run `npm run langfuse:verify` to confirm the fix; it must
> exit 0 before the instance holds a real trace.
>
> **As of 2026-09-22 neither can be re-checked at all** — the origin is gone
> (see the Status block and §3.1). Both stand as last observed on 2026-09-19:
> open, unfixed, and now unverifiable. Whatever comes back up at this hostname
> is a new instance as far as this gate is concerned and gets re-checked from
> scratch, whether or not it claims to be the same box.

### 3.1 A host that has vanished is not a hardened host (2026-09-22)

When the origin disappeared, the hardening checks nearly reported the opposite
of the truth. `checkOpenSignup` reads HTTP 404 on `/api/auth/signup` as *"the
route is compiled out — the strongest possible pass"*, and `checkCanonicalUrlTls`
abstains when `/api/auth/providers` does not answer. A host 404ing everything
therefore produced one finding, passing, and a report of `ok: true`: **safe to
put a child's answer into**. The only thing standing between that and a green
gate was `langfuse:verify` happening to run the version check first and exit.

Fixed by making liveness a precondition rather than one more check
(`checkInstanceLive` in `src/lib/observability/langfuse-hardening.ts`): a 404
only means "compiled out" on a box that is demonstrably still serving Langfuse
on `/api/public/health`. A *passing* liveness probe deliberately contributes no
finding, so "the host is up" can never stand in for a hardening conclusion.

The general rule, since this is the second time it has bitten on this gate:
**an absent signal is not a passing signal.** Both of the original §3 findings
were invisible from the ingest side; this one was invisible from the check side.

Non-negotiable, in this order:

1. **TLS.** Caddy or nginx in front, real certificate. No plaintext ingress.
2. **Firewall.** Only 80/443 and SSH reachable from the internet. Postgres,
   ClickHouse, Redis, and MinIO stay on the Docker network — never published to
   the host's public interface.
3. **SSH.** Key auth only, password auth off.
4. **Disable open sign-up** (`AUTH_DISABLE_SIGNUP=true`) once the team's accounts
   exist, otherwise anyone who finds the URL can register.
5. **Backups.** Nightly snapshot of the VM plus a Postgres dump. Untested backups
   do not count — restore once and write the result in this file.

Only after all five: create the org, project, and API keys.

## 4. Wire the app to it

The app reads three variables (`src/lib/env.ts`):

| Variable | Value |
| --- | --- |
| `LANGFUSE_BASEURL` | the HTTPS URL from step 3 |
| `LANGFUSE_PUBLIC_KEY` | `pk-lf-…` from the Langfuse project settings |
| `LANGFUSE_SECRET_KEY` | `sk-lf-…` from the same page |

Propose all three as Paperclip secrets (`steamkid/langfuse/*`) the moment they are
generated, then inject them into the deploy environment. A Langfuse key in the
repo, in an issue comment, or in a chat message is a leaked key — rotate it in
Langfuse rather than hoping.

`assertObservabilityReady()` refuses to boot a `preview` or `production` tier
without these, which is the intended behaviour: no untraced deployed AI calls.

### 4.1 `LANGFUSE_MIGRATION_V4_WRITE_MODE` must be `dual` — on both services

Langfuse v4 ships a migration switch that decides which ingestion event types the
instance will store. On the default `events_only` it accepts **only** score and
log events and refuses `trace-create`, `generation-create` and
`generation-update` — the three types the `langfuse` v3 JS SDK in our
`package.json` emits for every AI call.

The refusal arrives *per-event inside an HTTP 207*, which the SDK logs and
swallows. `flushAsync()` resolves, `callModel()` returns a trace id and a trace
URL, and every one of those URLs is dead. `events_only` also disables the read
API (`/api/public/traces/:id` and `/api/public/observations` 404), so nothing
contradicts the happy-looking output either.

```
LANGFUSE_MIGRATION_V4_WRITE_MODE=dual
```

Set it in the compose `.env` on **`langfuse-web` and `langfuse-worker` both**,
then restart both. Setting it on the web service alone is the nastier version of
the same bug: the batch is accepted with a clean 207 and the worker never
persists it, so the instance looks healthy from the ingest side and still stores
nothing. `checkLangfuseWriteMode` reads its own probe trace back for exactly
this reason and reports `not_readable` when that happens.

`dual` is an upstream **migration bridge** and will be removed. Moving off
`langfuse@3.39.2` onto a v4 client is real debt on someone else's clock, not a
permanent answer.

## 5. Prove it

- `npm run langfuse:verify` exits 0 — this now covers "is it v4+, not a v3
  patch", "will it actually store the events our SDK sends, and can the trace be
  read back" (§4.1), and "is it hardened enough to hold a child's answer" (§3).
  Today it exits 1.
- **Do not close a Langfuse recovery on `200` from `/api/public/health`.** That
  says the web service answers, not that a trace survives. `langfuse:verify`
  exiting 0 is the gate.
- `/api/health` on the deployed app reports `langfuse: true`
- one graded item produces a visible trace in the Langfuse UI
- the trace contains the redacted payload shape we expect, not raw identifier
  fields — check against `src/lib/privacy/redact.ts`

Until all three pass, the observability rail is not done.

## Operating notes

- Security updates on this box are ours. Unattended-upgrades on, and someone
  named owns it — an unowned VM holding children's data is the failure mode.
- Upgrading Langfuse: read the release notes for ClickHouse migrations before
  bumping the pinned tag. Snapshot first.
- If operating this proves more expensive than it is worth, the documented
  fallback is Langfuse Cloud Pro with EU residency **and** `referenceOnly()`
  on every free-text field — see the rejected alternatives in ADR 0002. That is
  a deliberate re-decision with a written trade-off, not a quiet switch.
