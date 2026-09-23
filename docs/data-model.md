# Data model

Drawn from `prisma/migrations/*/migration.sql` and the re-pulled
`prisma/schema.prisma`. Four Postgres schemas — `app`, `events`, `identity`,
`ml` — split into five diagrams, because one ER diagram with twenty-four tables
is a paragraph in disguise (see [docs/diagrams.md](diagrams.md), house rule 1).

Companion to [docs/architecture.md](architecture.md).

**Two things `prisma db pull` cannot show, so they are written here instead.**
The `ml.*` export views do not appear in `schema.prisma` at all (introspecting
views needs a preview feature), and neither do the triggers, CHECK constraints
or the `PARTITION BY RANGE` on `events.behavior_event`. The append-only
guarantee lives in the migrations, not in the Prisma file.

## 1. A child's work becomes a training label

This is the chain the company exists to collect: what the child wrote, what the
model said, and where a teacher disagreed. Every table on it is append-only,
enforced by a `BEFORE UPDATE OR DELETE` trigger calling `app.reject_mutation()`.

```mermaid
erDiagram
  "app.learner" ||--o{ "app.attempt" : "makes"
  "app.learner" ||--o{ "app.submission" : "writes"
  "app.learner" ||--o{ "app.ai_verdict" : "is graded by"
  "events.session" ||--o{ "app.attempt" : "groups"
  "app.exercise_item" ||--o{ "app.attempt" : "is answered by"
  "app.submission" ||--o{ "app.submission_draft" : "append-only history"
  "app.ai_verdict" ||--o{ "app.ai_verdict_criterion" : "one row per skill"
  "app.ai_verdict" ||--o{ "app.teacher_correction" : "is corrected by"
  "identity.user_account" ||--o{ "app.teacher_correction" : "written by teacher"

  "app.ai_verdict" {
    uuid id PK
    uuid langfuse_trace_id "CHECK equals correlation_id"
    uuid correlation_id "minted by the browser"
    text verdict_status "graded, unscorable, blocked_by_safety"
    text redaction_version "which redaction rules produced input_snapshot"
    jsonb input_snapshot
    numeric cost_usd
  }
  "app.teacher_correction" {
    uuid id PK
    text skill_code
    int original_level "read from ai_verdict_criterion inside the INSERT"
    int corrected_level
    text reason_code
  }
```

## 2. Content and rubrics

The versioned half. A score that cannot name the rubric version behind it is a
label nobody can clean later, so `rubric_version` is a table, not a column.

```mermaid
erDiagram
  "app.course" ||--o{ "app.lesson" : "contains"
  "app.lesson" ||--o{ "app.exercise_item" : "contains"
  "app.lesson" ||--o{ "app.submission" : "is answered by"
  "app.rubric" ||--o{ "app.rubric_version" : "versions"
  "app.rubric_version" ||--o{ "app.exercise_item" : "grades"
  "app.rubric_version" ||--o{ "app.ai_verdict" : "was applied by"

  "app.exercise_item" {
    uuid id PK
    text item_type
    jsonb skill_weights "which skills this item scores, and how much"
    jsonb correct_answer "never sent to the browser"
    int max_attempts
  }
  "app.rubric_version" {
    uuid id PK
    int version
    jsonb criteria
    text langfuse_prompt_name "links a score back to a prompt version"
  }
```

## 3. Skills and growth

`skill_state` is the current answer and `skill_state_history` is how it got
there — the second is append-only, so "this child improved at skill X" is a
claim you can recompute rather than a chart you have to trust.

```mermaid
erDiagram
  "app.learner" ||--o{ "app.skill_state" : "current mastery"
  "app.learner" ||--o{ "app.skill_state_history" : "snapshots, append-only"
  "app.learner" ||--o{ "app.learning_path_step" : "is offered"
  "app.skill" ||--o{ "app.skill_state" : "is measured by"
  "app.skill" ||--o{ "app.skill_state_history" : "is measured by"

  "app.skill" {
    text skill_code PK
    text signal_spec "the observable signal, required by the skill map"
    text skill_map_version
  }
  "app.skill_state" {
    numeric mastery
    numeric confidence
    int evidence_count "the gate on showing a child anything"
    text growth_label
    text growth_model_version
  }
```

## 4. Consent and identity

`consent_record` is append-only with a `superseded_by` self-link, so withdrawal
is a new row and the state at any past moment is still provable. Everything a
child could be recognised by lives in `identity.*` and in no other schema.

```mermaid
erDiagram
  "identity.user_account" ||--o{ "app.guardian_link" : "is guardian on"
  "app.learner" ||--o{ "app.guardian_link" : "is linked to"
  "identity.user_account" ||--o{ "app.consent_record" : "grants"
  "app.learner" ||--o{ "app.consent_record" : "is subject of"
  "app.consent_record" ||--o| "app.consent_record" : "superseded_by"
  "app.learner" ||--|| "identity.learner_profile" : "nickname and birth month"
  "identity.user_account" ||--o{ "identity.pii_access_log" : "who looked"

  "app.learner" {
    uuid id PK "never leaves our infrastructure"
    uuid public_ref UK "the only id allowed to leave"
    text consent_state "refreshed by trigger from consent_record"
    text grade_band
  }
  "identity.learner_profile" {
    uuid learner_id PK
    text display_name "never exported, never traced"
    date birth_year_month
  }
```

## 5. The behaviour log and the export surface

`events.behavior_event` deliberately has **no foreign keys**: it is
`PARTITION BY RANGE (event_time)` with monthly partitions, retention is
`DROP PARTITION`, and its primary key `(learner_id, event_id, event_time)` plus
the `event_time = app.uuidv7_timestamp(event_id)` CHECK is what makes
`ON CONFLICT DO NOTHING` a complete de-duplication rule.

```mermaid
erDiagram
  "app.learner" ||--o{ "events.session" : "sits down for, real FK"
  "events.session" ||--o{ "events.behavior_event" : "joined on session_id, no FK"
  "events.event_registry" ||--o{ "events.behavior_event" : "joined on name + version, no FK"

  "events.behavior_event" {
    uuid event_id PK "UUIDv7, CHECK-verified"
    timestamptz event_time PK "partition key, derived from event_id"
    jsonb payload "hashes and counts only, never typed text"
    text consent_scope_at_write "proves consent at write time"
    uuid correlation_id "same value as the Langfuse trace id"
  }
  "events.dead_letter" {
    text reason "refused at the gate, no FK to anything"
    jsonb payload_shape "shape, never values"
  }
```

`events.dead_letter` is drawn without edges on purpose: a refused event never
reached `behavior_event`, and its `learner_id` / `event_id` columns are nullable
with no foreign key, because the whole point is to record something that did not
validate.

The `ml.*` schema is the export surface and contains no tables of its own except
`ml.training_export_run` (one row per export: spec version, filters, consent
snapshot time, row count, checksum, redaction version). Everything else there is
a consent-filtered view, gated on the opt-in `training_use` scope:

| View | Rows |
| --- | --- |
| `ml.v_consented_learner` | **internal join surface, not an export** — the only view allowed to expose `learner_id`; `ml-views.test.ts` enforces that the others select `public_ref` only |
| `ml.v_grading_examples` | graded verdicts: item + rubric + redacted answer + the score that survived teacher review |
| `ml.v_teacher_corrections` | model level vs teacher level per skill. `note` is excluded — free text an adult typed about a child |
| `ml.v_behaviour_sequences` | events the registry marks `exportable`, for `scorable` sessions only |
| `ml.v_growth_labels` | `skill_state_history` snapshots as labels |
