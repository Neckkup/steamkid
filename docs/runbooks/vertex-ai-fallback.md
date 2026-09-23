# Runbook — moving steamkid from the Gemini developer API to Vertex AI

- **Status:** contingency plan. **Not scheduled. Do not execute preemptively.**
- **Written:** 23 September 2026, on [PRO-93](/PRO/issues/PRO-93), by the CTO.
- **Relates to:** [ADR 0004](../adr/0004-llm-provider-gemini.md) → "Accepted risk".
- **Executes when:** Google suspends, throttles, or terminates `GEMINI_API_KEY`
  on a terms basis — or a residency requirement lands that a US/EU pin satisfies.

The point of this document is that if grading stops on a Tuesday morning, nobody
has to start reading Google's terms of service for the first time.

## The headline: Vertex does not fix the reason we might need it

**Vertex AI carries the same under-18 restriction as the Gemini developer API.**
Google Cloud Service Specific Terms (last modified 16 Sep 2026),
§20 *Generative AI Services*:

> **(d) Age Restrictions.** Customer will not, and will not allow End Users to,
> use a Generative AI Service as part of a website, Customer Application, or
> other online service that is directed towards or is likely to be accessed by
> individuals under the age of 18.
>
> **(f) Suspected Violations.** Google may immediately suspend or terminate
> Customer's use of a Generative AI Service based on any suspected violation of
> Section 17(b) or subsection (d) above.
>
> **(g) Restrictions.** The restrictions contained in subsections (d) and (e)
> above are deemed to be "Restrictions" or "Use Restrictions" under the
> applicable Agreement.

Source: <https://cloud.google.com/terms/service-terms>.

So Vertex is a **continuity** plan, not a **compliance** plan. If Google acts
against us for serving under-18s, moving to Vertex moves us to the same clause
under a different contract. Treating it as an escape would be the expensive kind
of wrong — it would burn a day of engineering and leave the risk where it was.

**What it changes is who we are to Google.** The developer API is a consumer-ish
self-serve product where enforcement is an automated key action; Vertex is a
Cloud contract with a billing relationship, an account, and a support path. That
is worth something when you want a conversation instead of a `403` — but it is
posture, not permission, and this runbook does not claim more than that.

### The honest read

The only thing that actually removes this risk is a provider whose terms permit
a service for children. That is a re-decision of ADR 0004's provider choice, not
an endpoint change, and it belongs to the founder. This runbook does not open it.

## What Vertex does buy

| | |
| --- | --- |
| **Contractual no-training** | §18: "Google will not use Customer Data to train or fine-tune any AI/ML models without Customer's prior permission or instruction." Applies by contract, not by billing tier — so it cannot silently flip when someone re-issues a key. Today we get the equivalent from the paid tier, which is the weaker form of the same promise. |
| **Prompt retention limit** | §20(h): absent our instruction, Google will not store prompts longer than needed to create the output, nor store the output. |
| **A real data-residency pin** | §16 AI/ML Data Location — ML processing can be confined to a jurisdiction. **US or EU only.** See below. |
| **An account, not a key** | Suspension goes through a customer relationship with a support channel. |

## The residency answer, which is not the one ADR 0004 assumed

**A Singapore pin is not available.** ADR 0004's rejected-alternatives section
said Vertex would let inference "sit in `asia-southeast1` next to the database".
That was wrong, and the correction is now recorded in the ADR.

- Vertex's ML-processing residency guarantee (§16) is delivered through
  **multi-region endpoints**, and there are exactly two:
  `https://aiplatform.us.rep.googleapis.com` (`us`) and
  `https://aiplatform.eu.rep.googleapis.com` (`eu`).
- Ordinary regional endpoints like `asia-southeast1` exist, but Google's own
  documentation says plainly: *"Endpoints don't guarantee data residency or
  in-region ML processing."* Calling `asia-southeast1` buys latency, not a
  commitment.

Source: <https://cloud.google.com/vertex-ai/generative-ai/docs/learn/locations>,
and the AI/ML Data Location list at <https://cloud.google.com/terms/data-residency>.

**Consequence for us.** Our Postgres is in Singapore (ADR 0003). Taking Vertex's
residency guarantee means pinning inference to the **US or the EU** — further
from the data, not closer. If a Thai PDPA requirement ever lands demanding
in-country or in-ASEAN processing, **no Google option satisfies it**, and the
provider choice itself has to reopen.

**Not verified:** whether `gemini-3.8-flash` is served from the
`asia-southeast1` *regional* endpoint at all. Google renders that availability
matrix client-side and it could not be read from the page source. It is left
unverified deliberately, because it does not change any decision here — a
regional endpoint carries no residency guarantee either way. Check it at
migration time if latency matters.

## The code change

Small, and it is small on purpose — ADR 0004 spends its budget keeping it that way.

### What moves

**`src/lib/ai/client.ts` — `getGemini()`, about ten lines.** The same
`@google/genai` v2.23 client class reaches both backends; `GoogleGenAIOptions`
takes `vertexai` (or the newer `enterprise`), `project`, `location`, and
`googleAuthOptions` instead of `apiKey`.

```ts
gemini = new GoogleGenAI({
  vertexai: true,                       // or: enterprise: true
  project: env.GOOGLE_CLOUD_PROJECT,
  location: env.GOOGLE_CLOUD_LOCATION,  // 'us' or 'eu' for a residency pin
});
```

For a residency pin the SDK must also be pointed at the `.rep.googleapis.com`
host via `httpOptions.baseUrl` — the plain `location` string alone routes to a
standard endpoint. Verify this against the SDK at migration time rather than
trusting this snippet; it is the one line here that has not been run.

**`src/lib/env.ts` + `.env.example`.** `GEMINI_API_KEY` becomes
`GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_LOCATION` plus a credential. Keep the
paid-tier comment — it stops being load-bearing (§18 is stronger), but the
reasoning is still what a reader needs.

**`src/lib/ai/models.ts` — re-verify rates, do not assume.** Vertex publishes its
own price list. If any rate moves, bump `PRICING_VERSION` in the same commit, or
every cost chart silently splices two price regimes together.

### What does not move — and this is the whole design

Traces, prompt versions, cost accounting, redaction, the pseudonymous
`learnerRef`, `ModelSafetyBlockError`, structured output, thinking-level
mapping, and every caller of `callModel()`. All of it sits above the provider.
`vendor-boundary.test.ts` needs no change either: `@google/genai` stays, and no
second SDK enters the tree.

*(Lens: the boundary is real — [PRO-28](/PRO/issues/PRO-28) proved it once
already by moving Anthropic → Gemini with 48/48 tests green.)*

### Model IDs

Same names (`gemini-3.8-flash`, `gemini-3.1-flash-lite`, `gemini-2.5-pro`,
`gemini-2.5-flash-lite`). Vertex historically also accepts fully-qualified
publisher paths; the short IDs are what the SDK sends. Confirm against the
locations page for the chosen endpoint before the cutover — a model missing from
your endpoint is the most likely failure, and it fails at the first call.

## Time to execute

Roughly **one working day of engineering**, gated on a human with GCP console
access. Ordered by what blocks what:

| Step | Owner | Time |
| --- | --- | --- |
| 1. GCP project with billing, Vertex AI API enabled, service account + JSON key (or Workload Identity on the deploy target) | **Founder** — console session, we cannot do this | 30–60 min |
| 2. Inject credentials as runtime secrets (never the repo) | CTO / Backend | 15 min |
| 3. `getGemini()` + `env.ts` + `.env.example` | [AIEngineer](/PRO/agents/aiengineer) | 1–2 h |
| 4. Confirm model IDs and endpoint availability; re-verify rates in `models.ts` | AIEngineer | 1 h |
| 5. `npm run ai:smoke` — a real call, trace read back from Langfuse | AIEngineer | 30 min |
| 6. Grading eval run, compare agreement to the Gemini baseline | AIEngineer + [QA](/PRO/agents/qa) | 2 h |
| 7. Amend ADR 0004, update this runbook | CTO | 30 min |

**Step 1 is the long pole and it is not an engineering task.** If the risk in
ADR 0004 ever materialises, the first action is to message the founder for GCP
access, not to open an editor.

### Rollback

Keep `GEMINI_API_KEY` in the environment through the cutover. Reverting is
reverting one commit and one env var — but note the obvious: if we are here
because Google suspended the key, rollback is not available. That asymmetry is
why the eval run in step 6 is not optional.

## Cost

List prices for Gemini models are the same order on both surfaces, so the
~$0.0045 per graded item in ADR 0004 is the right planning number. **Do not
treat it as verified** — re-read Vertex's price list at migration time and
re-price `models.ts` from it. Cost also stops being a single line item: Vertex
bills through GCP alongside whatever else the project runs, so the
cost-per-graded-item dashboard in Langfuse becomes the *only* place that number
is legible.

## If the risk materialises: first hour

1. **Confirm the failure mode.** A terms suspension reads as sustained `403` /
   permission errors on every model, not intermittent `429`s or `503`s. Check
   the Langfuse error rate and the Sentry issue before assuming the worst.
2. **Tell the founder immediately**, in Thai, with the blast radius stated
   plainly: grading is down, and it is a contract action, not a bug we can fix.
3. **Ask for the GCP console session** (step 1 above) in the same message. That
   is the critical path.
4. **Do not silently degrade grading.** A refusal must never land as a child's
   zero — that invariant is [PRO-76](/PRO/issues/PRO-76) and it already holds in
   code. Submissions queue; they do not get graded badly.
5. **Then execute steps 2–7.**

## Review

Re-read whenever ADR 0004 is amended, and whenever Google's Service Specific
Terms change — the §20 numbering has already shifted once ("formerly Section
19"), so cite the clause heading, not the number.
