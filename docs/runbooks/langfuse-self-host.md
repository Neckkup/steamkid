# Runbook — Langfuse self-host

- **Status:** ready to execute, waiting on VM spend approval
- **Owner:** CTO
- **Issue:** PRO-12
- **Why self-hosted at all:** `docs/adr/0002-observability-and-privacy.md`

This is the whole procedure. Once the VM exists it is mechanical — do not redesign
it on the day, and do not substitute Langfuse Cloud "just to unblock", because the
reason we self-host is that our traces carry children's free-text answers.

## 1. The machine

Target: **4 vCPU / 8 GB RAM / ≥80 GB disk**, Ubuntu LTS. ClickHouse is the reason
for the 8 GB; it will not run comfortably under that.

Recommended: Hetzner CPX31, EU region (≈USD 17/month). Any provider is acceptable
if it meets the spec and the region is EU or Singapore — **not** a US region, for
the same reason the data does not go to a US SaaS.

Record the provider, region, instance id, and monthly cost on PRO-12 when created.

## 2. Bring up the stack

Langfuse publishes an official Docker Compose that covers every component we need:
`langfuse-web`, `langfuse-worker`, Postgres, ClickHouse, Redis/Valkey, and
S3-compatible storage (MinIO). Use it — do not hand-assemble the services.

```bash
git clone https://github.com/langfuse/langfuse.git
cd langfuse
# pin a release tag rather than tracking main
docker compose up -d
```

**Pin a v4 tag, not v3.** Alerting is the deciding constraint: Langfuse's built-in
alerts (Slack / webhook / GitHub Actions) are self-hostable only from v4, and the
company rule is that we do not write our own alerting. On v3 the cost and error-rate
alerts in `ai-observability.md` cannot be configured at all. v3 also loses
`GET /api/public/v2/metrics`, which the dashboards query.

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

## 5. Prove it

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
