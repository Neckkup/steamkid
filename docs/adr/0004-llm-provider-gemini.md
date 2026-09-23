# ADR 0004 — LLM provider: the Gemini API, paid tier

- **Status:** accepted — with a recorded accepted risk, see below
- **Date:** 2026-09-19 (amended 2026-09-23: paid-tier gate closed, under-18
  restriction recorded as an accepted risk)
- **Decided by:** CTO, on the founder's explicit instruction (18 Sep 2026, 21:34)
- **Issue:** [PRO-27](/PRO/issues/PRO-27) (implemented in [PRO-28](/PRO/issues/PRO-28))
- **Supersedes:** the `AI provider | Anthropic (external API)` row in [ADR 0001](0001-stack.md)

## Decision

1. **The Gemini API is steamkid's single LLM provider.** Every model call goes
   through `src/lib/ai/client.ts`, which uses `@google/genai` against
   `generativelanguage.googleapis.com`.
2. **The key must belong to a billing-enabled Google Cloud project — the paid
   tier.** A free-tier key is not an acceptable substitute, not even in
   development, not even "just to test the pipeline". This is the load-bearing
   constraint of this ADR; see "Why the paid tier is not optional" below.
3. **One provider, enforced in a test.** `src/lib/vendor-boundary.test.ts` fails
   the build if `@anthropic-ai/sdk`, `openai`, `@mistralai/mistralai`, or
   `cohere-ai` enters `package.json`. Adding a second provider means amending
   this ADR and that allow-list in the same commit.
4. **We use the Gemini *developer* API, not Vertex AI.** See the rejected
   alternatives — this is the one part of the decision with a real cost, and it
   is the data-residency cost.
5. **The observability contract from [ADR 0002](0002-observability-and-privacy.md)
   is unchanged and provider-independent.** Every call is wrapped in
   `traceAiCall()` with model, prompt name + version, token counts (thinking
   tokens included), USD cost, latency, and the error when there is one. Trace
   `userId` stays the pseudonymous `learnerRef`; trace metadata stays on the
   `ALLOWED_TRACE_METADATA_KEYS` allow-list. An AI call without a trace is, by
   team definition, an unfinished feature.

### Registered models

Priced in `src/lib/ai/models.ts`, which is the single source of truth for rates.

| Model | Role | Why |
| --- | --- | --- |
| `gemini-3.8-flash` | **Default.** Grading and feedback. | Most capable Flash tier; cheaper per token than `gemini-2.5-pro`. |
| `gemini-3.1-flash-lite` | Behaviour tagging, routing. | High volume, low stakes. |
| `gemini-2.5-pro` | Deep-reasoning escalation, grading A/B. | Registered so an escalation is a prompt-version change, not a code change. |
| `gemini-2.5-flash-lite` | Observability canary. | The cheapest thing that can answer. |

## Why the paid tier is not optional

**Free-tier Gemini traffic is used to improve Google's products.** The paid tier
is not. That single difference is what makes this a children's-data decision
rather than a billing preference.

What reaches the model on a grading call is a child's actual answer — the
free-text a nine-year-old wrote about photosynthesis, which our redaction layer
provably cannot sanitise (ADR 0002 makes this argument at length: regexes catch
identifier *shapes*, not *"my name is ก้อง and my school is …"* inside an essay).
On a free-tier key, that text becomes training data for a third party,
permanently, and no later deletion request makes it un-trained.

*(Lens: blast radius of children's data — assume every identifier that leaves our
infrastructure is permanent.)*

This is also why the constraint is repeated at four enforcement points rather
than living only in this document:

- `src/lib/env.ts:44` — on the `GEMINI_API_KEY` definition
- `src/lib/ai/client.ts:27` — on the function every AI feature calls
- `src/lib/ai/models.ts:4` — on the rate card, which is paid-tier pricing
- `.env.example:19` — where someone pastes a key

**Operational consequence:** whoever issues the key must confirm billing is
enabled on the project *before* the key is used, and re-confirm that the
current Gemini API terms still draw the free/paid line the same way. A key that
cannot be shown to be paid-tier is rejected.

**Correction (22 Sep 2026).** This paragraph originally named
[PRO-29](/PRO/issues/PRO-29) as the acceptance gate for that confirmation. That
was wrong, and the error mattered: PRO-29 could only prove the *pipeline* works,
never the *tier of the key*, because **no Gemini API call reports the tier of the
key making it**. The key we hold starts with `AQ.`, which is Google Cloud's newer
key format, not evidence of billing. The confirmation has to come from the person
who issued the key, and it is now tracked on its own ticket,
[PRO-75](/PRO/issues/PRO-75), so a closed ticket cannot swallow it.

The gate is therefore **the first real learner answer, not the first API call.**
Synthetic-only traffic (`ai:smoke`, eval fixtures, seeded dev data) may run
against an unconfirmed key; a child's free text may not.

## Accepted risk: we are outside the provider's age restriction, on purpose

**This section exists so that a reader in three months does not conclude we
never knew.** We knew, we wrote it down, and the account owner decided to carry
it.

| | |
| --- | --- |
| **Risk** | Account and service-continuity risk (see below). Not a training-data risk. |
| **Decided by** | The founder — the owner of the Google Cloud account and of the business. |
| **Date** | 23 September 2026 (answered on [PRO-75](/PRO/issues/PRO-75), recorded in `founder-answers-gemini-gate`; written up here on [PRO-93](/PRO/issues/PRO-93)). |
| **Rejected alternative** | Move to Vertex AI. Recommended by the CTO, declined by the founder. |
| **Status** | Live. Reviewed against the contingency plan in [`docs/runbooks/vertex-ai-fallback.md`](../runbooks/vertex-ai-fallback.md). |

### What the risk is

The Gemini API Additional Terms say:

> "You also will not use the Services as part of a website, application, or
> other service (collectively, "API Clients") that is directed towards or is
> likely to be accessed by individuals under the age of 18."

steamkid is a STEAM learning product for children. We are squarely inside that
sentence, and the terms make no exception for the paid tier — this restriction
is orthogonal to billing.

**What the risk is not.** It is *not* that a child's answer becomes training
data. Paid tier closed that: Google does not use paid-tier prompts or responses
to improve its products, the founder confirmed billing is active on 23 Sep 2026,
and that is the harm this ADR was originally written to prevent.

**What the risk is.** Google may suspend or terminate access to the API at any
time on a suspected violation. If that happens:

- Grading stops **product-wide and without notice.** `callModel()` is the only
  path to a model; there is no second provider by design (and
  `vendor-boundary.test.ts` enforces that).
- **No amount of better engineering prevents it.** This is a contract term, not
  a defect. Retries, redaction, rate limiting, and a nicer prompt do not move it.
- The trigger is outside our observability. Nothing in Langfuse predicts a
  terms-enforcement action; the first signal is production `403`s.

*(Lens: irreversible-first — a provider suspension is not a code path we can
roll back to.)*

### Why the recommendation was declined, and why we proceeded anyway

The CTO recommended checking Vertex AI's terms and planning a move. The founder,
having seen that recommendation, chose to accept the risk and continue on the
Gemini developer API. That is the account owner's call to make, and it is
recorded as made rather than re-litigated.

**The check was done anyway, and it changed the picture.** Vertex AI carries
*the same* age restriction (Google Cloud Service Specific Terms §20(d), with an
explicit suspension right in §20(f)). Moving would not have removed this risk —
so the founder's decision costs us less than it looked like it would when the
recommendation was written. See
[`docs/runbooks/vertex-ai-fallback.md`](../runbooks/vertex-ai-fallback.md) for
the evidence and for what a move would and would not buy.

### What this obliges us to do

1. **Keep the provider swap cheap.** Every model call stays behind
   `callModel()` in `src/lib/ai/client.ts`. Developer-API-only features are
   forbidden, because they raise the cost of the one mitigation we have.
2. **Keep the contingency plan current.** The fallback runbook is reviewed
   whenever this ADR is.
3. **Re-decide if the facts change** — see the trigger list below.

## Why Gemini rather than Anthropic

The founder decided this, and the decision is recorded as made. The engineering
reasons that make it comfortable to implement rather than merely obey:

**Cost per graded item.** `gemini-3.8-flash` at $0.75/$3.75 per 1M tokens prices
a graded item at roughly **$0.0045** (see the estimate below). That is the unit
that decides whether per-child AI grading survives contact with a Thai consumer
price point. Cheaper inference is not a nice-to-have here; it is the business
model.

**Thinking-level control without a second vocabulary.** Gemini 3.x exposes a
coarse `thinkingLevel`, the 2.5 family a token `thinkingBudget`. `models.ts`
maps prompts' declared `effort` onto whichever the model takes, so grading
quality is tunable per prompt version rather than per code change.

**The switch was cheap, which tells us the boundary is real.** [PRO-28](/PRO/issues/PRO-28)
moved the client with typecheck green and 48/48 tests passing. Everything
expensive — traces, prompt versions, cost accounting, redaction, the
pseudonymous `learnerRef` — sits above the provider and did not move. That is
the property worth protecting, and it is why a future provider change is also
cheap.

### What we give up

**Data residency.** The Gemini developer API does not offer the regional
processing pin that Vertex AI does — requests are served globally. ADR 0003 put
our Postgres in Singapore (`ap-southeast-1`) deliberately; inference does not
get the same guarantee. We accept this for the MVP because paid-tier terms
(no training on our data) address the harm we actually care about, while
residency is a compliance property we do not yet have a regulator asking about.
It is recorded here as a known gap, not as a solved problem.

**Anthropic's published safety tuning for minors.** A real consideration for a
children's product, and the reason grading quality is measured on a Langfuse
dataset run rather than assumed. If agreement numbers on the eval set come out
materially worse, that is evidence to bring back to the founder — with numbers,
per this ADR's re-decision trigger.

## Rejected alternatives

**Anthropic (the previous decision, ADR 0001).** Rejected by founder decision.
Engineering-wise the trade was roughly: better published safety posture for
minors, materially higher cost per graded item at the tiers we would use. Not
re-litigated here. Superseded, not deleted — ADR 0001's row now points here.

**Vertex AI (the same Gemini models, via Google Cloud).** The genuinely close
call, and the one worth revisiting. It buys regional processing (so inference
could sit in `asia-southeast1` next to the database), a CMEK story, and an
enterprise data-governance commitment that does not depend on reading the
consumer terms correctly. Rejected *for now* because it costs a GCP project with
service-account/ADC auth instead of one API key, which is a human console
session we do not have — and because the MVP's actual blocker is shipping a
graded item at all. **This is the upgrade path if a residency requirement
appears**, and it is a contained change: same models, same SDK family, a
different client constructor in one file.

**Corrected 23 Sep 2026 — two claims in this paragraph were wrong.** (a) The
residency it buys is a **US or EU** multi-region pin, not a Singapore one;
Vertex's contractual ML-processing residency has no `asia-southeast1` option, so
moving there would put inference *further* from the database, not next to it.
(b) It does **not** escape the under-18 restriction — Google Cloud's Service
Specific Terms §20(d) carries the same sentence. Both checks are written up in
[`docs/runbooks/vertex-ai-fallback.md`](../runbooks/vertex-ai-fallback.md).

**OpenAI.** Rejected. No reason to introduce a third vendor's terms and a third
pricing model when the founder has decided between the two on the table.

**Two providers behind an abstraction ("provider-agnostic from day one").**
Rejected, and enforced against by `vendor-boundary.test.ts`. A second provider
doubles the places where a trace, a prompt version, a cost number, and a
redaction decision have to be correct — and those four are exactly where a
child's data leaks if we get it wrong. One provider, one pipeline, one place to
audit. *(Lens: buy before build — but buy* one *of a thing.)*

## Cost at MVP scale

Assumptions, so the number can be argued with: **200 active learners**, 20
graded items per learner per month, 10 sessions each with 3 behaviour-tagging
calls, an hourly canary, and 3 eval runs of 150 items.

| Workload | Model | Volume/mo | Unit cost | Monthly |
| --- | --- | --- | --- | --- |
| Grading (1.2k in / 250 out / 700 thinking) | `gemini-3.8-flash` | 4,000 items | $0.00446 | **$17.85** |
| Behaviour tagging (400 in / 80 out) | `gemini-3.1-flash-lite` | 6,000 calls | $0.00022 | **$1.32** |
| Eval / dataset runs | `gemini-3.8-flash` | 450 items | $0.00446 | **$2.01** |
| Observability canary | `gemini-2.5-flash-lite` | 720 calls | $0.00004 | **$0.03** |
| | | | | **≈ $21 / month** |

Roughly **$0.0045 per graded item** (~0.16 THB). Call it **under $25/month** at
MVP scale with headroom for retries and prompt growth.

**Two things that move this number, both already modelled in `models.ts`:**

1. **Thinking tokens are ~59% of a grading call's cost.** They bill at the
   output rate and are *not* included in `candidatesTokenCount`, so a naive
   in/out reading under-reports spend by more than half. Dropping grading from
   `medium` to `low` effort is the single biggest available saving — but it is a
   grading-quality decision, made against a measured agreement number, not a
   budget decision.
2. **`gemini-3.8-flash` doubles on 2027-01-01.** Same volume, same month:
   grading goes to $35.70 and the total to roughly **$39/month**. The rate card
   carries its effective date so this shows up as a planned step change rather
   than a billing surprise.

Budget impact belongs on [PRO-13](/PRO/issues/PRO-13). At this scale the Gemini
line is not the thing that decides the budget; the Langfuse self-host is.

## Migration cost if we are wrong

| If wrong about | Cost to change |
| --- | --- |
| Gemini vs Anthropic/OpenAI | **Low.** [PRO-28](/PRO/issues/PRO-28) is the proof: one client file, one rate-card file, one env var. Traces, prompt versions, cost accounting, and redaction are provider-independent by construction. |
| Developer API vs Vertex AI | **Low, and now measured.** `@google/genai` v2.23 reaches Vertex from the *same* client class via `vertexai: true` + `project`/`location`, so the change is `getGemini()` in `src/lib/ai/client.ts` plus env vars and credentials — roughly a day of work, most of it the GCP console session we do not have. Grows if we start using developer-API-only features — so don't. Detail: [`docs/runbooks/vertex-ai-fallback.md`](../runbooks/vertex-ai-fallback.md). |
| Paid tier being sufficient for children's data | **Unrecoverable for data already sent.** This is the asymmetric one. It is why the constraint is enforced at four code sites and gated on [PRO-75](/PRO/issues/PRO-75) rather than trusted. |
| Cost per graded item | **Low, and observable.** `costDetails` goes to Langfuse on every call, so drift shows up on a dashboard before it shows up on a bill. |
| Single-provider boundary | **Low.** Amend this ADR and the allow-list in `vendor-boundary.test.ts` together. |

## Re-decision trigger

Reopen this ADR if any of these happen:

- Gemini's terms change how the free/paid training distinction works, **or** the
  paid tier's no-training commitment weakens.
- A residency requirement lands (Thai PDPA guidance, a school-district customer,
  an investor's diligence) → Vertex AI is the only lever we have, and it only
  offers a **US or EU** pin. If the requirement is "data stays in Thailand" or
  "stays in ASEAN", no Google option satisfies it and this ADR's provider choice
  has to be reopened, not just its endpoint.
- **Google suspends or throttles the key on a terms basis** → execute
  [`docs/runbooks/vertex-ai-fallback.md`](../runbooks/vertex-ai-fallback.md)
  and bring the founder the re-decision, because the accepted risk above has
  materialised.
- The age restriction moves in either direction — Google adds a
  children's/education carve-out, or tightens enforcement → re-open the accepted
  risk with the founder.
- Grading agreement on the eval dataset comes out materially below what the
  Anthropic baseline would have given → bring the numbers to the founder.
- Monthly Gemini spend exceeds **$100** at under 500 learners → the unit
  economics assumption in this ADR is wrong, and the model mix needs rework.

## Verification status

Updated 22 Sep 2026. The observability claims above are no longer
implemented-and-unit-tested only; they are end-to-end proven.

- Code, typecheck, and tests: done on [PRO-28](/PRO/issues/PRO-28) (48/48 passing).
- **A real traced Gemini call has been made and read back.**
  [PRO-29](/PRO/issues/PRO-29) ran `npm run ai:smoke` against the live key and the
  self-hosted Langfuse:

  | | |
  | --- | --- |
  | Trace | `01a0c7d2-b292-7b26-9404-882e4a78a7c0` on `langfuse.homekup.com` |
  | Model | `gemini-3.1-flash-lite` |
  | Tokens | 169 in / 19 out / 0 thinking |
  | Cost | $0.000071, matching `models.ts` rates at `PRICING_VERSION` 2026-09-18 |
  | Latency | 1363 ms |
  | Prompt | `ops/observability-smoke` v1, served from Langfuse (not the repo fallback) |

  The script re-reads `GET /api/public/traces/{id}` before exiting 0, so this is a
  trace that was stored, not a URL that was printed. That check exists because the
  instance had been running in `events_only` mode and was silently rejecting every
  `generation-create` inside an HTTP 207 the SDK swallowed — see
  [PRO-64](/PRO/issues/PRO-64) / [PRO-72](/PRO/issues/PRO-72).

- **That $0.000071 is not a cost per graded item.** It priced a 169-token smoke
  prompt. It proves the cost pipeline works; it says nothing about the $0.0045
  estimate below, which is measured against a real rubric on
  [PRO-8](/PRO/issues/PRO-8).

- **The tier of the key is confirmed — 23 Sep 2026.** The founder answered on
  [PRO-75](/PRO/issues/PRO-75) that the project issuing `GEMINI_API_KEY` is
  linked to an **active billing account**, and confirmed the free/paid terms line
  is unchanged. That is the only evidence that can exist (no Gemini endpoint
  reports the tier of the key calling it), and it comes from the person who
  issued the key. **The children's-data gate this ADR set is therefore open**:
  real learner answers may now go through `GEMINI_API_KEY` without becoming a
  third party's training data.
- **Terms re-read 22 Sep 2026** (Gemini API Additional Terms, last modified
  28 Apr 2026): the free/paid training line is unchanged — paid services are not
  used to improve Google products; unpaid services are, and may be human-reviewed.
  The first re-decision trigger has not fired.
- **The under-18 restriction found on that read is now an accepted risk, not an
  open blocker.** The founder chose on 23 Sep 2026 to carry it. See "Accepted
  risk" above. It is not closed and it is not solved; it is owned.
- **Other gates that are still shut and that this ADR does not control:**
  [PRO-74](/PRO/issues/PRO-74) (leaked Langfuse key not yet rotated),
  [PRO-34](/PRO/issues/PRO-34) (Langfuse still open to self-signup),
  [PRO-16](/PRO/issues/PRO-16) (no proven Postgres restore).
