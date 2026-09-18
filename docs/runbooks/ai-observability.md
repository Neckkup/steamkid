# Runbook — AI observability

- **Owner:** AIEngineer
- **Issue:** PRO-5
- **Why it looks like this:** `docs/adr/0002-observability-and-privacy.md`
- **Standing up the instance:** `docs/runbooks/langfuse-self-host.md` (PRO-12)

Every AI call in steamkid goes through one function and lands in Langfuse with a
model, a prompt version, token counts, a USD cost, a latency and an outcome. An
AI feature without a trace is, by team definition, unfinished.

## Where the traces are

| What | Where |
| --- | --- |
| Traces, one per AI call | Langfuse → Tracing, filter `environment` |
| Cost / latency / error charts | Langfuse → Dashboards → "AI cost, latency and errors" |
| Prompts and rubrics, versioned | Langfuse → Prompts |
| A specific call from a log line | `traceUrl(traceId)` prints an openable link |

Environments are separate and never mixed: `development` (laptops), `preview`
(Vercel previews), `production`. The tag comes from `APP_ENV` via
`langfuseEnvironment` in `src/lib/env.ts`. Scope every dashboard and alert to one
environment — a cost alert that a developer's smoke test can trip gets muted, and
a muted alert is not an alert.

## Adding a trace to a new feature

There is one supported way to reach a model:

```ts
import { callModel } from "@/lib/ai/client";

const result = await callModel({
  promptName: "grading/short-answer",   // must exist in PROMPT_REGISTRY
  traceName: "grade.short-answer",      // stable; dashboards group on it
  learnerRef: learner.id,               // pseudonymous surrogate key, never an email
  variables: { submission: answerText },
  outputSchema: shortAnswerSchema,      // structured output, not prose
});
```

That gives you a trace, a generation, the prompt version, the cost and the
latency for free. The steps around it:

1. **Register the prompt** in `src/lib/ai/prompts.ts` — name, `feature`, model
   config, and a fallback copy. `callModel` refuses an unregistered prompt rather
   than inventing one.
2. **Push it to Langfuse:** `npm run langfuse:prompts -- --push`. From then on the
   Langfuse version is what production runs; the in-repo copy is only a fallback.
3. **Treat the child's text as data, never instructions.** Deliver it inside a
   delimiter (`<learner_text>…</learner_text>`) and say so in the system message.
   Copy the pattern from `ops/observability-smoke`.
4. **Do not put a child's free text on the trace.** `callModel` defaults the trace
   input to a `referenceOnly()` pointer; the content stays in our database. Pass
   `traceInput` explicitly only where the privacy policy allows retention.
5. **Add a metadata key you want to filter on** to `ALLOWED_TRACE_METADATA_KEYS`
   in `src/lib/observability/langfuse.ts`. It is an allow-list: anything not
   listed is dropped before the payload is built.
6. **Verify on the wire, not in your head.** `src/lib/ai/client.test.ts` and
   `langfuse.test.ts` assert against the actual bytes sent to the ingestion
   endpoint. Add a case there rather than inspecting objects before they ship.

Check it end to end with `npm run ai:smoke`: one real, cheap call that prints the
trace URL, the prompt version, tokens, cost and latency, using a deliberately
hostile input (a name, an email, a phone number and a prompt-injection attempt).
If the trace URL does not open, the pipeline is broken.

## Dashboards

Defined as code in `src/lib/observability/dashboards.ts` and pushed with:

```bash
npm run langfuse:dashboards            # dry run
npm run langfuse:dashboards -- --push
```

Edit the file, not the UI — a `--push` overwrites UI edits by widget name. Widget
definitions are validated against Langfuse's supported measures and dimensions in
`dashboards.test.ts`, because a misspelled measure renders an empty chart instead
of an error.

| Widget | Answers |
| --- | --- |
| Cost per graded item (avg USD) | What one grade costs, the number quoted when proposing a model |
| Cost per graded item by prompt version | Which prompt version made grading more expensive |
| Spend by prompt / Monthly spend | Where the money goes, and the monthly bill |
| Latency p95 by prompt | How long a child waits, at the tail, not the average |
| Grading latency distribution | Whether a bad p95 is a long tail or a bimodal split |
| Calls by level (ERROR vs DEFAULT) | Error rate |
| Failed calls by prompt | Whether failure is one prompt or the whole provider |
| Calls served by the in-repo fallback prompt | Runs that cannot be attributed to a prompt version. Must be zero in production |
| Output tokens by model | Whether spend moved because of the model or longer answers |

**Cost per learner per month needs one number Langfuse does not have.** The
observations view cannot group by `userId`, so Langfuse supplies the numerator
(monthly spend) and the denominator — monthly active learners — comes from the
app database. It is a division done when reporting, not a chart. If we ever need
it charted, the answer is a Langfuse score or metadata dimension, not a
home-grown metrics table.

## Alerts

Langfuse configures alerts **in the UI only** — there is no API, so they cannot
be version-controlled here. This table is the spec; whoever stands up the
instance configures it and ticks the row. Self-hosted alerting requires
**Langfuse v4+**.

Scope every one of these to `environment = production`.

| Alert | View / measure | Condition | Window | Channel |
| --- | --- | --- | --- | --- |
| Grading error rate | observations, `count`, filter `level = ERROR`, `metadata.feature = grading` | warn `> 5`, alert `> 20` | 1 hour | Slack |
| Any AI errors | observations, `count`, filter `level = ERROR` | alert `> 50` | 1 hour | Slack |
| Cost spike, hourly | observations, `sum(totalCost)` | warn `> 2`, alert `> 5` (USD) | 1 hour | Slack |
| Cost per item regression | observations, `avg(totalCost)`, filter `metadata.feature = grading` | alert `> 0.02` (USD) | 6 hours | Slack |
| Grading latency | observations, `p95(latency)`, filter `metadata.feature = grading` | warn `> 15`, alert `> 30` (s) | 1 hour | Slack |
| Fallback prompt in production | observations, `count`, filter `metadata.promptSource = fallback` | alert `> 0` | 1 hour | Slack |

Thresholds are opening positions set before real traffic exists. Revisit them
once a week of production data is in — an alert that fires every day teaches the
team to ignore it.

Missing-data handling: treat **no data as OK** for the error and cost alerts (a
quiet hour is a quiet hour), and set renotification to 24 hours so a sustained
problem does not go silent after the first message.

## What must never appear in a trace

- a child's name, email, phone number, school, or auth subject
- a child's free-text answer, unless the privacy policy explicitly allows it for
  that field
- an API key, of ours or anyone else's

Three independent layers enforce this, in this order: `callModel` defaults the
trace input to a pointer; `traceAiCall` runs the payload through `redactDeep`
and the metadata allow-list; and the SDK-level `mask` in `getLangfuse()` scrubs
the input and output of *every* event the SDK ships, including observations
someone adds without reading this file.

`REDACTION_VERSION` in `src/lib/privacy/redact.ts` is written onto traces and
verdict rows. Bump it whenever the rules change — it is what makes "which
redaction rules produced this payload" answerable for data recorded months ago,
including data recorded before we found a gap.
