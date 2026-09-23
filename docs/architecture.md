# steamkid architecture

What is actually wired together in this repository today, drawn from `src/` and
`prisma/` rather than from intent. Every diagram here is Mermaid, per
[docs/diagrams.md](diagrams.md).

**Read this first.** A diagram that flatters the code is worse than no diagram,
because it is believed. Where the code and a decision document disagree, the
diagram shows the code and the disagreement is written down in
[What the code does not do yet](#what-the-code-does-not-do-yet). The data model
has its own file: [docs/data-model.md](data-model.md).

| Diagram | What it answers |
| --- | --- |
| [System context](#1-system-context) | Which services exist and where a child's data may go |
| [Learner request path](#2-the-learner-request-path-as-it-runs-today) | What happens when a child presses submit, today |
| [AI grading path](#3-the-ai-grading-path-traceaicall-redact-gemini) | How a grading call reaches the model, and how it fails |
| [Page routes](#4-route-map--pages) / [API routes](#5-route-map--api) | The shape of `src/app` |
| [Privacy boundary](#6-privacy-boundary) | What crosses out of our infrastructure, and through what |

## 1. System context

Look at the boundary: everything outbound leaves through `src/lib/privacy/redact.ts`
or through the Gemini prompt, and nothing else has an exit.

```mermaid
flowchart LR
  child["Child's browser"] -->|"answers, behaviour events"| app
  teacher["Teacher browser"] -->|"skill corrections"| app

  subgraph ours["Our infrastructure — a child's identity may exist here"]
    app["Next.js app, src/app"]
    db[("Postgres — app / events / identity / ml")]
    langfuse["Langfuse, self-hosted (ADR 0002)"]
  end

  subgraph third["Third parties — pseudonymous or redacted only"]
    gemini["Gemini developer API"]
    sentry["Sentry Cloud"]
  end

  app -->|"Prisma + node-postgres"| db
  app -->|"prompt with the answer text"| gemini
  app -->|"trace: userId = public_ref"| langfuse
  app -->|"scrubbed errors"| sentry
  vertex["Vertex AI — contingency runbook, no code"]
  gemini -.->|"not implemented; ADR 0004"| vertex
```

## 2. The learner request path, as it runs today

Follow the `correlationId`: it is minted in the route, returned to the browser,
and put on the behaviour events, which is what joins a child's clicks to their
attempt later. Note what is absent — no model is called on this path.

```mermaid
sequenceDiagram
  participant C as Practice screen (src/app/learn/[slug]/practice)
  participant A as POST /api/attempts
  participant G as gradeItem (src/lib/learning/grade.ts)
  participant S as Learning store
  participant E as POST /api/events
  participant D as Postgres

  C->>A: answer + timings + hintsUsed
  A->>A: zod parse, item lookup, minChars floor
  A->>A: getConsentState()
  alt no consent record
    A-->>C: 403 consent_required
  else consented
    A->>G: gradeItem(item, answer)
    alt closed item (mcq / numeric / ordering)
      G-->>A: graded + explanation
    else written item
      G-->>A: pending_ai — no grader wired (PRO-8)
    end
    A->>S: recordAttempt(correlationId, answer, timings)
    S->>D: insert app.attempt
    A-->>C: attemptId, correlationId, status
  end
  C->>E: item.answer_submitted / item.result_shown (correlationId)
  E->>D: append events.behavior_event, or events.dead_letter
```

## 3. The AI grading path: traceAiCall, redact, Gemini

This is the code in `src/lib/learning/ai-grade.ts` and `src/lib/ai/client.ts`.
The caller is what to notice: today only `scripts/grading-eval.ts` reaches it, so
the path is real and tested but no learner route enters it.

```mermaid
sequenceDiagram
  participant R as Caller (scripts/grading-eval.ts)
  participant GW as gradeWritten()
  participant CM as callModel()
  participant T as traceAiCall()
  participant M as Gemini API
  participant L as Langfuse
  participant D as Postgres

  R->>GW: item + submissionText + correlationId
  GW->>GW: resolveRubric, sanitiseLearnerText
  GW->>CM: promptName, variables, outputSchema, metadata
  CM->>T: name, learnerRef, correlationId, allow-listed metadata
  T->>T: resolveTraceIdentity, throws if learnerRef has no correlationId
  alt hardening gate refuses the destination
    T->>T: log the suppressed trace, grading continues untraced
  else destination allowed
    T->>L: trace id = correlation_id, input via redactDeep
  end
  T->>M: generateContent(systemInstruction, contents)
  alt model returns JSON
    M-->>T: criteria + feedback + usage
    T->>L: generation with tokens, USD cost, latency
    GW-->>R: status = graded, or unscorable if it fails the schema
  else safety block
    M-->>T: blockReason, or finishReason = SAFETY
    T->>L: redacted error output, tagged error
    GW-->>R: status = blocked_by_safety, never a score of zero
  end
  R->>D: save verdict + criteria (append-only)
  Note over R,D: Only review-fixtures.ts calls SqlVerdictStore.save() today
```

## 4. Route map — pages

Read it as three audiences. `/teacher` is the one with a hard edge: the whole
subtree is rewritten to a 404 on the production tier by `src/proxy.ts`.

```mermaid
flowchart TD
  root["/ — landing, src/app/page.tsx"] -->|"เริ่มเรียนเลย"| learn
  root -->|"เริ่มต้นใช้งาน"| consent["/consent — guardian grants scopes"]
  root -->|"quiet link"| me

  subgraph learner["learner"]
    learn["/learn — lesson list"] -->|"pick a lesson"| lesson["/learn/[slug]"]
    lesson -->|"ไปลองตอบคำถามกัน"| practice["/learn/[slug]/practice"]
    practice -->|"after the last item"| project["/learn/[slug]/project"]
    project -->|"ส่งงานของหนู"| result["/results/[submissionId]"]
  end

  subgraph growth["the child's own view"]
    me["/me — การเติบโตของหนู"]
  end

  subgraph teach["teacher — rewritten to a 404 in production by src/proxy.ts"]
    tlist["/teacher — class list"] -->|"one child"| tlearner["/teacher/[learnerRef]"]
    tlist -->|"งานที่รอครูดู"| tqueue["/teacher/review — queue"]
    tqueue -->|"one verdict"| tverdict["/teacher/review/[verdictId]"]
  end

  learn -->|"การเติบโตของหนู"| me
  learn -.->|"no consent record — every learner page does this"| consent
```

## 5. Route map — API

Grouped by who calls them. Everything a child produces lands in `app.*` or
`events.*`; nothing here reads a model.

```mermaid
flowchart LR
  subgraph cons["consent"]
    c["/api/consent — GET, POST, DELETE"]
  end

  subgraph work["learner work"]
    a["POST /api/attempts"]
    s["POST /api/submissions"]
    e["POST /api/events"]
  end

  subgraph teach["teacher"]
    v["/api/verdicts/[id]/override — GET, POST"]
  end

  subgraph ops["ops"]
    h["GET /api/health"]
    sw["POST /api/internal/sweep-sessions — bearer secret"]
  end

  c -->|"consent_record"| appdb[("app.*")]
  a -->|"attempt"| appdb
  s -->|"submission + submission_draft"| appdb
  v -->|"teacher_correction, append-only"| appdb
  e -->|"behavior_event / dead_letter"| evdb[("events.*")]
  sw -->|"closes idle sessions"| evdb
  h -->|"reads validated config, touches no table"| envcheck["src/lib/env.ts"]
```

## 6. Privacy boundary

The one thing to take away: `redact.ts` guards Langfuse and Sentry, **not**
Gemini. A child's answer text reaches the model in full, deliberately — that is
what ADR 0004's paid-tier, zero-retention posture is buying.

```mermaid
flowchart LR
  answer["Child's answer text"] -->|"sanitiseLearnerText only, no redaction"| gemini["Gemini API"]
  answer -->|"referenceOnly() pointer by default"| redact
  meta["Trace metadata"] -->|"pickAllowed, allow-list of 18 keys"| redact
  ref["learner.public_ref"] -->|"Langfuse userId, never learner.id"| redact
  out["Model output, incl. evidence fragment"] -->|"redactDeep on trace.update"| redact
  err["Errors, breadcrumbs, request URL"] -->|"scrubEvent + redactDeep"| redact

  redact["src/lib/privacy/redact.ts — REDACTION_VERSION 1.3.0"]
  redact -->|"traceAiCall, plus the SDK-wide mask"| langfuse["Langfuse, self-hosted"]
  redact -->|"beforeSend, sendDefaultPii off"| sentry["Sentry Cloud"]

  never["display_name, birth_year_month, avatar_key, email, ip_hash"]
  never --x|"DENIED_KEY_PATTERNS — no code path exports these"| ext["Any external service"]
```

## What the code does not do yet

Written here rather than fixed in code, because this issue is documentation.
Each line is a place a reader would otherwise trust a diagram that is ahead of
the repository.

1. **There is no Vertex AI fallback in the code.** `grep -ri vertex src/` returns
   nothing. [ADR 0004](adr/0004-llm-provider-gemini.md) *rejected* Vertex and
   [the runbook](runbooks/vertex-ai-fallback.md) is explicitly "contingency plan,
   not scheduled, do not execute preemptively". The runbook also records that
   Vertex carries the same under-18 restriction, so it is a continuity plan, not
   a compliance one. The diagram shows it dotted and unimplemented.
2. **No learner-facing route calls the grader.** `/api/attempts` answers
   `pending_ai` for written items and `/api/submissions` answers
   `awaiting_grading`; `gradeWritten()` is reachable only from
   `scripts/grading-eval.ts`. The grading engine exists; it is not connected.
3. **Nothing in product code writes `app.ai_verdict`.** The only caller of
   `SqlVerdictStore.save()` is `src/lib/learning/review-fixtures.ts`, so the
   teacher review queue is populated by fixtures. The override path
   (`POST /api/verdicts/[id]/override`) is real and writes real rows.
4. **`README.md` says `prisma/schema.prisma` holds "domain tables land in
   PRO-3 / PRO-7"** — they have landed, and the schema header now says the SQL
   migrations are the source of truth. The README layout table is stale.
5. **Langfuse traces may legally carry answer text but do not.** ADR 0002 chose
   self-hosting precisely so a trace can show what was graded, yet `callModel()`
   still defaults `input` to a `referenceOnly()` pointer. Deliberate or not, the
   ADR's stated benefit is currently unclaimed.
6. **There is no classroom in the schema.** `/teacher` lists every learner with a
   snapshot, as its own page comment says.
