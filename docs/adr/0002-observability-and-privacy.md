# ADR 0002 — Observability and children's privacy

- **Status:** accepted (self-host target), interim posture active until the host exists
- **Date:** 2026-09-18 (amended 2026-09-23: leaked credentials recorded as an
  accepted risk, gated on the pilot)
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

## Accepted risk: the leaked credentials are still live, on purpose

**This section exists so that a reader in three months does not conclude we
never noticed.** We noticed, we costed the fix at two minutes, and the account
owner decided to carry the risk instead.

| | |
| --- | --- |
| **Risk** | Three credentials pasted in plaintext on a board comment remain valid: the Langfuse key pair (`pk-lf-…` / `sk-lf-…`) and the Gemini API key. |
| **Decided by** | The founder — the owner of both accounts. |
| **Date** | 23 September 2026 (answered on [PRO-74](/PRO/issues/PRO-74)). |
| **Rejected alternative** | Rotate now: new key pair in Langfuse, new key in Google AI Studio, revoke both old ones, update `steamkid/langfuse/public-key`, `steamkid/langfuse/secret-key`, `steamkid/gemini/api-key`. Recommended by the CEO and the CTO, declined by the founder. |
| **Status** | Live, with a hard expiry enforced in code since 23 September 2026 — see the gate below. |

### What happened

On 19 September 2026 the founder handed the team its credentials by pasting
them into a comment on [PRO-30](/PRO/issues/PRO-30). Board comments are readable
through the board's API, so all three values are leaked by definition: we cannot
prove nobody read them, and a key that was ever in plaintext is not recoverable
by deleting the message. The comment stays — the founder chose to keep it, and
removing it would not make the keys any safer.

A closer probe on 23 September 2026 (PRO-101) found the situation is not the one
the first paragraph of this section assumed, and the difference matters:

- The Langfuse pair **this app is configured with is no longer the leaked one.**
  A second pair was issued at some point — most plausibly during the instance
  rebuild of 20–22 September ([PRO-64](/PRO/issues/PRO-64),
  [PRO-66](/PRO/issues/PRO-66)) — and nobody recorded it.
- **The leaked pair was never deleted.** Both pairs answer `200` on
  `/api/public/projects` and `/api/public/traces` for the `steamkid` project. The
  earlier "still valid" confirmation via the [PRO-73](/PRO/issues/PRO-73) gate
  had been run with the pair in use, which cannot answer the question.
- The **Gemini key in use is still byte-identical to the leaked value** and still
  authorises calls (`200` from `v1beta/models`).

So rotation here is not "issue a new key". Issuing one already happened and
changed nothing: the published pair still opens the project. Only deleting the
old pair does, which is why the code gate below tests the old pair rather than
comparing the new one.

### What the risk is, today and after the pilot opens

Today the exposure is **budget and noise**. Whoever holds the Gemini key can
bill model calls to our project. Whoever holds `sk-lf-…` can write junk traces.
Langfuse currently holds nothing but our own test traffic, so the worst case is
an invoice and a cleanup.

The day a real student's work reaches Langfuse the same `sk-lf-…` becomes a
**read** credential over children's free-text answers, through `/api/public/*`,
project-wide. Redaction does not help here: it strips identifiers from a trace,
it does not stop an authenticated holder of the project key from reading what
remains. Open signup on the instance ([PRO-34](/PRO/issues/PRO-34)) compounds it.

That is the line this accepted risk stops at.

### The gate

**No real student trace reaches Langfuse until the leaked pair stops opening the
project.** As of 23 September 2026 this is enforced in code, not remembered:
`src/lib/observability/leaked-credentials.ts` runs inside the same gate as the
hardening checks ([PRO-84](/PRO/issues/PRO-84)), so a trace carrying a
`learnerRef`, a `sessionId` or a `submissionId` is refused while the leak is
open. Dev, eval and smoke traces are untouched, and a child is still graded — a
lost trace is a debugging cost, a leaked answer is not recoverable.

The check is a live probe **with the leaked pair**, not a comparison against the
key in use, because a comparison would already read as "rotated" today and be
wrong. Two consequences follow:

- The leaked pair is supplied as `LANGFUSE_REVOKED_PUBLIC_KEY` /
  `LANGFUSE_REVOKED_SECRET_KEY` from the secret store. The repo holds only
  SHA-256 of each leaked value, which pins what the check will accept as the
  thing being tested without being usable as a credential.
- The gate opens by itself. Delete the old pair and the next probe gets a `401`,
  the finding flips, and traces flow within five minutes with no deploy. It can
  open on evidence; it cannot close on a promise.

Clearing it is two minutes of the founder's time and needs nobody else:

1. Langfuse → Project Settings → API Keys → **delete the pair created on
   19 September 2026.** Do not create another one: the app already uses a newer
   pair, and creating a third is what made this look fixed the first time.
2. Google AI Studio → API keys → create a new key, delete the old one.
3. Paperclip → Secrets → update `steamkid/gemini/api-key` with the new value.
   `steamkid/langfuse/public-key` and `steamkid/langfuse/secret-key` already hold
   the newer pair and need no change. The existing bindings for the CTO and the
   AIEngineer keep working; nothing is re-created.

New values go in the Secrets page only. Never in a comment, a commit, or a
document — including this one.

## Open items owned elsewhere

- Per-field collect / retain / redact / exportable table → PRO-3 (privacy policy).
- Consent scopes and the behaviour-event payload → PRO-7 (Backend).
- Prompt versioning, evals, and scoring conventions inside Langfuse → PRO-5
  (AIEngineer).
