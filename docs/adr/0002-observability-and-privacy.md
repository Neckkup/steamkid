# ADR 0002 — Observability and children's privacy

- **Status:** accepted (self-host target), interim posture active until the host exists
- **Date:** 2026-09-18
- **Decided by:** CTO
- **Issue:** PRO-4

## Decision

1. **Langfuse is self-hosted.** AI traces never reach a third-party SaaS.
2. **Sentry is Cloud**, free Developer tier, with PII scrubbing enforced in code
   and Session Replay permanently disabled.
3. **Everything bound for an external service passes through
   `src/lib/privacy/redact.ts`.** This holds even for self-hosted Langfuse —
   defence in depth, and it keeps the export path honest.
4. **Until the self-hosted instance exists**, AI work runs against a local
   `docker compose` Langfuse. No steamkid trace goes to Langfuse Cloud, not even
   during development.

## Why Langfuse is self-hosted and not Cloud

The deciding factor is not the vendor's security posture — Langfuse Cloud offers
EU residency, a GDPR DPA, and SOC2/ISO27001 reports on Pro. The deciding factor is
**what a useful AI trace has to contain.**

The entire point of tracing the grading engine is to see what the model saw: the
child's actual answer. Our redaction layer catches identifier *shapes* — emails,
phone numbers, national IDs — and denied field names. It cannot catch a nine-year-old
writing *"my name is ก้อง and my school is …"* inside an essay answer about
photosynthesis. No regex can. So there are only two coherent options:

- **Cloud**, and free-text answers must be replaced by `referenceOnly()` pointers.
  Traces then show that grading happened but not what was graded — which removes
  most of the reason to trace grading at all.
- **Self-host**, and traces may carry the answer text, because the text never
  leaves infrastructure we control and is already covered by the consent record
  the guardian signed.

We chose the option that keeps the traces useful. *(Blast radius of children's
data: every identifier that leaves our infrastructure is permanent. Self-hosting
is how we make sure none does.)*

Secondary reasons: the training dataset is the company's actual asset, and traces
are a large part of how it gets curated — we do not want that corpus living in a
vendor's retention policy; and per-unit trace pricing makes "trace everything"
a cost decision, which is exactly the wrong incentive when the rule is *every AI
call is traced.*

## Rejected alternatives

**Langfuse Cloud Hobby (free, 50k units/month, 30-day retention).** Rejected.
Zero infrastructure work and no cost, but 30-day retention alone disqualifies it
for a growth product where we compare a child in week 1 to week 12, and the
free-text problem above is unsolved. Would have been the fastest path.

**Langfuse Cloud Pro with EU residency + `referenceOnly()` on all free text.**
The most defensible *Cloud* option, and the fallback if self-hosting proves too
costly to operate. Rejected for now: $199/month, and it buys traces that cannot
show the graded content.

**Build our own trace store.** Rejected outright — company rule, and correctly
so. Prompt versioning, evals, and dataset curation are a product, not a
weekend's work.

**No AI observability until after the MVP.** Rejected. Data we do not capture
from the first user is gone forever, and a grading engine whose early failures
were never recorded cannot be evaluated later.

## What self-hosting actually costs us

Langfuse self-host needs: the Langfuse web + worker containers, **Postgres**,
**ClickHouse** (OLAP store for traces/observations/scores), **Redis/Valkey**, and
**S3-compatible blob storage**. That is meaningfully more than "run one
container" — ClickHouse is the component that sets the memory floor.

- Estimated: one small VM (≈4 vCPU / 8 GB) running the official Docker Compose
  stack, roughly **USD 20–40/month**, plus object storage.
- The core platform is free and open source. Only enterprise add-ons
  (org creators, instance management API, UI customisation) need a licence key.
  We need none of them.
- Ops burden is real: backups, upgrades, and ClickHouse disk growth are ours.
  This is the honest cost of the decision, and the reason the Cloud Pro fallback
  stays documented rather than deleted.

**Spend approval for the VM is the CEO's call, not mine.** Until it is approved
and the host is running, the interim posture in decision (4) applies.

## Why Sentry is Cloud

Sentry is bought, not built, and the free Developer tier covers an MVP. Unlike an
AI trace, a crash report has no legitimate reason to contain a child's work — so
here redaction is sufficient rather than best-effort, and it is enforced in code
rather than by convention (`src/lib/observability/sentry-options.ts`):

- `sendDefaultPii: false` — no IPs, cookies, or request bodies collected.
- `beforeSend` strips request bodies, query strings, cookies, and headers; scrubs
  breadcrumb messages, `extra`, and exception messages; and reduces `user` to an
  id at most.
- **Session Replay is disabled** (`replaysSessionSampleRate: 0`,
  `replaysOnErrorSampleRate: 0`). Replay records what a child typed on screen;
  it is never enabled on this product.
- `SENTRY_AUTH_TOKEN` is build-time only, for source-map upload. The DSN is
  public by design and safe in client bundles.

If Sentry ever needs to hold something we would not want a vendor to keep, the
answer is to stop sending it, not to upgrade the plan.

## Enforcement, not convention

A rule that lives only in a document gets broken by the third contributor.

- `traceAiCall()` in `src/lib/observability/langfuse.ts` is the only supported
  path to an LLM. It builds the trace, redacts input and output, tags failures,
  and flushes before the serverless function freezes.
- Trace metadata is an **allow-list** (`ALLOWED_TRACE_METADATA_KEYS`), not a
  deny-list. A new field is invisible to the vendor until someone adds it
  deliberately.
- Trace `userId` is the pseudonymous `learnerRef`, never an email or auth subject.
- `assertObservabilityReady()` in `src/lib/env.ts` fails any `APP_ENV` other than
  `local` that has no Langfuse keys.
- CI runs a secret scan that fails the build on a credential-shaped string.
- `src/lib/privacy/redact.test.ts` covers the redaction layer, including the case
  of an identifier hiding inside an allow-listed field.

## Migration cost if we are wrong

| If wrong about | Cost to change |
| --- | --- |
| Self-hosting Langfuse | Low-to-medium. Switching to Cloud is an env-var change (`LANGFUSE_BASEURL` + keys) plus turning on `referenceOnly()` for free text. Historical traces would either be migrated or left behind on the old instance. |
| Sentry Cloud | Low. DSN swap; no product code depends on the vendor. |
| Redaction being a choke point | This is the cheap insurance. If it turns out to be unnecessary we have lost a little trace fidelity; if it is missing when we need it, the loss is permanent. |

## Open items owned elsewhere

- Per-field collect / retain / redact / exportable table → PRO-3 (privacy policy).
- Consent scopes and the behaviour-event payload → PRO-7 (Backend).
- Prompt versioning, evals, and scoring conventions inside Langfuse → PRO-5
  (AIEngineer).
