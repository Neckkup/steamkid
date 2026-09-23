-- Migration 3 of 3 for PRO-7: the product tables the pipe joins to, and the
-- consent-filtered `ml` views the training export reads.
--
-- Source of truth: PRO-3 `data-schema` v1.1.0 §3.2–§3.5 and §6.
--
-- REVERSIBLE: `down.sql` drops every object created here. Safe while empty.
--
-- The `ml` views are in this migration rather than in PRO-10 for one reason:
-- PRO-7's acceptance criterion is "no consent = not in the export". A filter
-- that arrives with the export job is a filter someone can forget to apply.
-- Here it is the only way to read the data at all.

-- ---------------------------------------------------------------------------
-- §3.2 content and items
-- ---------------------------------------------------------------------------
CREATE TABLE app.course (
  id          uuid PRIMARY KEY,
  slug        text NOT NULL UNIQUE,
  title       text NOT NULL,
  subject     text NOT NULL,
  grade_band  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.lesson (
  id              uuid PRIMARY KEY,
  course_id       uuid NOT NULL REFERENCES app.course(id),
  slug            text NOT NULL UNIQUE,
  title           text NOT NULL,
  order_index     int NOT NULL,
  content_version int NOT NULL DEFAULT 1,
  est_minutes     int,
  media           jsonb NOT NULL DEFAULT '[]',
  skill_tags      text[] NOT NULL DEFAULT '{}'
);
CREATE INDEX lesson_course_idx ON app.lesson (course_id, order_index);

CREATE TABLE app.rubric (
  id   uuid PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL
);

CREATE TABLE app.rubric_version (
  id                     uuid PRIMARY KEY,
  rubric_id              uuid NOT NULL REFERENCES app.rubric(id),
  version                int NOT NULL,
  criteria               jsonb NOT NULL,
  -- Prompts live in Langfuse. We store the pointer, never a copy: two stores of
  -- one prompt is two versions of one prompt.
  langfuse_prompt_name    text,
  langfuse_prompt_version int,
  created_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rubric_id, version)
);

CREATE TABLE app.exercise_item (
  id                uuid PRIMARY KEY,
  lesson_id         uuid NOT NULL REFERENCES app.lesson(id),
  item_type         text NOT NULL CHECK (item_type IN ('mcq', 'numeric', 'short_text', 'long_text', 'ordering')),
  prompt            text NOT NULL,
  correct_answer    jsonb,
  difficulty        int NOT NULL CHECK (difficulty BETWEEN 1 AND 3),
  difficulty_weight numeric NOT NULL,
  max_attempts      int NOT NULL DEFAULT 3,
  hint_texts        text[] NOT NULL DEFAULT '{}',
  rubric_version_id uuid REFERENCES app.rubric_version(id),
  skill_weights     jsonb NOT NULL,
  content_version   int NOT NULL DEFAULT 1
);
CREATE INDEX exercise_item_lesson_idx ON app.exercise_item (lesson_id);

CREATE TABLE app.skill (
  skill_code        text PRIMARY KEY,
  kind              text NOT NULL CHECK (kind IN ('cognitive', 'behaviour')),
  name_th           text NOT NULL,
  name_en           text NOT NULL,
  signal_spec       text NOT NULL,
  skill_map_version text NOT NULL
);

COMMENT ON COLUMN app.skill.signal_spec IS
  'The formula in words, so it can be argued with. Seeded from skill-map.v1.json - never hard-coded in app code.';

-- ---------------------------------------------------------------------------
-- §3.3 learner work. A child's typed answer exists here and nowhere else.
-- ---------------------------------------------------------------------------
CREATE TABLE app.attempt (
  id                    uuid PRIMARY KEY,
  learner_id            uuid NOT NULL REFERENCES app.learner(id),
  item_id               uuid NOT NULL REFERENCES app.exercise_item(id),
  session_id            uuid NOT NULL REFERENCES events.session(id),
  attempt_no            int NOT NULL,
  started_at            timestamptz NOT NULL,
  submitted_at          timestamptz NOT NULL,
  answer_payload        jsonb NOT NULL,
  answer_hash           text NOT NULL,
  time_on_item_ms       int NOT NULL,
  active_time_on_item_ms int NOT NULL,
  answer_changes        int NOT NULL DEFAULT 0,
  hints_used            int NOT NULL DEFAULT 0,
  is_final              boolean NOT NULL DEFAULT false,
  low_validity          boolean NOT NULL DEFAULT false,
  suspected_assisted    boolean NOT NULL DEFAULT false,
  correlation_id        uuid NOT NULL,
  UNIQUE (learner_id, item_id, attempt_no)
);
CREATE INDEX attempt_correlation_idx ON app.attempt (correlation_id);
CREATE INDEX attempt_session_idx ON app.attempt (session_id);

COMMENT ON COLUMN app.attempt.answer_payload IS
  'The only place a child''s raw answer is stored (data-schema decision 5). Behaviour events carry answer_hash, never this.';
COMMENT ON COLUMN app.attempt.active_time_on_item_ms IS
  'Idle time already removed. Every score formula reads this, not time_on_item_ms.';

CREATE TABLE app.submission (
  id              uuid PRIMARY KEY,
  learner_id      uuid NOT NULL REFERENCES app.learner(id),
  lesson_id       uuid NOT NULL REFERENCES app.lesson(id),
  draft_count     int NOT NULL DEFAULT 0,
  content         jsonb NOT NULL,
  submitted_at    timestamptz,
  total_active_ms int NOT NULL DEFAULT 0,
  correlation_id  uuid NOT NULL
);
CREATE INDEX submission_learner_idx ON app.submission (learner_id, submitted_at DESC);
CREATE INDEX submission_correlation_idx ON app.submission (correlation_id);

CREATE TABLE app.submission_draft (
  id            uuid PRIMARY KEY,
  submission_id uuid NOT NULL REFERENCES app.submission(id),
  draft_no      int NOT NULL,
  content       jsonb NOT NULL,
  char_count    int NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (submission_id, draft_no)
);
CREATE TRIGGER submission_draft_append_only
  BEFORE UPDATE OR DELETE ON app.submission_draft
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

COMMENT ON TABLE app.submission_draft IS
  'Append-only. How one piece of work developed is the signal; overwriting drafts erases it.';

-- ---------------------------------------------------------------------------
-- §3.4 AI verdicts and teacher corrections - the company asset
-- ---------------------------------------------------------------------------
CREATE TABLE app.ai_verdict (
  id                uuid PRIMARY KEY,
  subject_type      text NOT NULL CHECK (subject_type IN ('attempt', 'submission')),
  subject_id        uuid NOT NULL,
  learner_id        uuid NOT NULL REFERENCES app.learner(id),
  rubric_version_id uuid REFERENCES app.rubric_version(id),
  model             text NOT NULL,
  prompt_name       text,
  prompt_version    int,
  input_snapshot    jsonb NOT NULL,
  redaction_version text NOT NULL,
  scores            jsonb NOT NULL,
  overall_score     numeric,
  feedback_text     text NOT NULL,
  model_confidence  numeric,
  latency_ms        int,
  tokens_in         int,
  tokens_out        int,
  cost_usd          numeric(10, 6),
  langfuse_trace_id uuid NOT NULL,
  correlation_id    uuid NOT NULL,
  verdict_status    text NOT NULL DEFAULT 'ok'
                    CHECK (verdict_status IN ('ok', 'schema_invalid', 'model_error', 'timeout')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- data-schema §5 makes this an obligation, so it is a constraint and not a
  -- convention: one id ties the child's clicks, the API call and the trace.
  CONSTRAINT ai_verdict_trace_is_correlation CHECK (langfuse_trace_id = correlation_id)
);
CREATE INDEX ai_verdict_subject_idx ON app.ai_verdict (subject_type, subject_id, created_at DESC);
CREATE INDEX ai_verdict_correlation_idx ON app.ai_verdict (correlation_id);
CREATE INDEX ai_verdict_learner_idx ON app.ai_verdict (learner_id, created_at DESC);

CREATE TRIGGER ai_verdict_append_only
  BEFORE UPDATE OR DELETE ON app.ai_verdict
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

COMMENT ON COLUMN app.ai_verdict.input_snapshot IS
  'Exactly what was sent to the model, after redaction. This is what a training example replays - not the raw answer.';

CREATE TABLE app.teacher_correction (
  id                 uuid PRIMARY KEY,
  ai_verdict_id      uuid NOT NULL REFERENCES app.ai_verdict(id),
  teacher_user_id    uuid NOT NULL REFERENCES identity.user_account(id),
  corrected_scores   jsonb NOT NULL,
  corrected_feedback text,
  reason_code        text NOT NULL CHECK (reason_code IN (
                       'too_harsh', 'too_lenient', 'missed_criterion', 'wrong_reasoning', 'other')),
  note               text,
  langfuse_score_id  text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX teacher_correction_verdict_idx ON app.teacher_correction (ai_verdict_id, created_at DESC);

CREATE TRIGGER teacher_correction_append_only
  BEFORE UPDATE OR DELETE ON app.teacher_correction
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

COMMENT ON TABLE app.teacher_correction IS
  'The highest-quality label we will ever have. Append-only: a teacher changing their mind is a second row, and the disagreement is itself signal.';

CREATE VIEW app.score_effective AS
SELECT v.id AS verdict_id,
       v.subject_type,
       v.subject_id,
       v.learner_id,
       v.created_at AS graded_at,
       COALESCE(c.corrected_scores, v.scores) AS scores,
       (c.id IS NOT NULL) AS teacher_corrected,
       c.id AS correction_id
FROM app.ai_verdict v
LEFT JOIN LATERAL (
  SELECT tc.id, tc.corrected_scores
  FROM app.teacher_correction tc
  WHERE tc.ai_verdict_id = v.id
  ORDER BY tc.created_at DESC, tc.id DESC
  LIMIT 1
) c ON true
WHERE v.verdict_status = 'ok';

COMMENT ON VIEW app.score_effective IS 'The score that counts. A teacher always beats the model.';

-- ---------------------------------------------------------------------------
-- §3.5 skill state and learning path
-- ---------------------------------------------------------------------------
CREATE TABLE app.skill_state (
  learner_id           uuid NOT NULL REFERENCES app.learner(id),
  skill_code           text NOT NULL REFERENCES app.skill(skill_code),
  mastery              numeric NOT NULL,
  confidence           numeric NOT NULL,
  evidence_count       int NOT NULL,
  assist_index         numeric NOT NULL,
  growth_label         text NOT NULL,
  growth_kind          text,
  growth_delta         numeric,
  reason_codes         text[] NOT NULL DEFAULT '{}',
  last_evidence_at     timestamptz,
  growth_model_version text NOT NULL,
  computed_at          timestamptz NOT NULL,
  PRIMARY KEY (learner_id, skill_code)
);

CREATE TABLE app.skill_state_history (
  id                   uuid PRIMARY KEY,
  learner_id           uuid NOT NULL REFERENCES app.learner(id),
  skill_code           text NOT NULL REFERENCES app.skill(skill_code),
  snapshot_at          timestamptz NOT NULL,
  mastery              numeric NOT NULL,
  confidence           numeric NOT NULL,
  assist_index         numeric NOT NULL,
  evidence_count       int NOT NULL,
  growth_label         text NOT NULL,
  growth_kind          text,
  growth_delta         numeric,
  reason_codes         text[] NOT NULL DEFAULT '{}',
  growth_model_version text NOT NULL
);
CREATE INDEX skill_state_history_idx
  ON app.skill_state_history (learner_id, skill_code, snapshot_at DESC);

CREATE TRIGGER skill_state_history_append_only
  BEFORE UPDATE OR DELETE ON app.skill_state_history
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

CREATE TABLE app.learning_path_step (
  id                uuid PRIMARY KEY,
  learner_id        uuid NOT NULL REFERENCES app.learner(id),
  target_type       text NOT NULL CHECK (target_type IN ('lesson', 'item', 'exercise_set')),
  target_id         uuid NOT NULL,
  reason            jsonb NOT NULL,
  policy_version    text NOT NULL,
  rank              int NOT NULL,
  status            text NOT NULL DEFAULT 'offered'
                    CHECK (status IN ('offered', 'started', 'completed', 'skipped', 'expired')),
  offered_at        timestamptz NOT NULL DEFAULT now(),
  resolved_at       timestamptz,
  langfuse_trace_id uuid,
  correlation_id    uuid NOT NULL
);
CREATE INDEX learning_path_step_learner_idx ON app.learning_path_step (learner_id, rank);

-- ---------------------------------------------------------------------------
-- §6 ml - built for export from day one
-- ---------------------------------------------------------------------------
CREATE TABLE ml.training_export_run (
  id                   uuid PRIMARY KEY,
  spec_version         text NOT NULL,
  dataset_kind         text NOT NULL
                       CHECK (dataset_kind IN ('grading', 'behaviour_sequence', 'growth_label')),
  filters              jsonb NOT NULL,
  consent_snapshot_at  timestamptz NOT NULL,
  row_count            int NOT NULL,
  output_uri           text NOT NULL,
  checksum             text NOT NULL,
  redaction_version    text NOT NULL,
  created_by_user_id   uuid,
  created_at           timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE ml.training_export_run IS
  'One row per export. consent_snapshot_at is what makes an old file explainable later.';

-- The gate. `training_use` is opt-in and defaults to off, so a learner appears
-- here only because a guardian actively said yes.
CREATE VIEW ml.v_consented_learner AS
SELECT l.id AS learner_id, l.public_ref, l.grade_band, l.locale
FROM app.learner l
JOIN app.consent_current c ON c.learner_id = l.id AND c.scope = 'training_use'
WHERE c.granted = true AND l.deleted_at IS NULL AND l.status = 'active';

COMMENT ON VIEW ml.v_consented_learner IS
  'INTERNAL JOIN SURFACE, NOT AN EXPORT. The only view in ml allowed to expose learner_id, because the others need a key to join on. Exported views select public_ref only - `ml-views.test.ts` enforces that.';

-- Grading dataset: input = item + rubric + redacted answer, label = the score
-- that survived teacher review.
CREATE VIEW ml.v_grading_examples AS
SELECT cl.public_ref AS learner_ref,
       cl.grade_band,
       v.id AS verdict_id,
       v.correlation_id,
       i.prompt,
       i.item_type,
       i.difficulty,
       i.skill_weights,
       rv.criteria AS rubric,
       v.input_snapshot AS learner_answer_redacted,
       v.scores AS ai_scores,
       se.scores AS effective_scores,
       se.teacher_corrected,
       v.model,
       v.prompt_name,
       v.prompt_version,
       v.redaction_version,
       v.created_at
FROM app.ai_verdict v
JOIN ml.v_consented_learner cl ON cl.learner_id = v.learner_id
JOIN app.score_effective se ON se.verdict_id = v.id
LEFT JOIN app.attempt a ON a.id = v.subject_id AND v.subject_type = 'attempt'
LEFT JOIN app.exercise_item i ON i.id = a.item_id
LEFT JOIN app.rubric_version rv ON rv.id = v.rubric_version_id
WHERE v.verdict_status = 'ok';

-- Behaviour dataset: what the child did, in order, per session. Only events the
-- registry marks exportable, and only for a scorable session - a tab left open
-- is not a learning sequence.
CREATE VIEW ml.v_behaviour_sequences AS
SELECT cl.public_ref AS learner_ref,
       cl.grade_band,
       e.session_id,
       s.started_at AS session_started_at,
       s.active_ms AS session_active_ms,
       e.client_seq,
       e.event_time,
       e.event_name,
       e.event_version,
       e.lesson_id,
       e.item_id,
       e.submission_id,
       e.correlation_id,
       e.payload
FROM events.behavior_event e
JOIN ml.v_consented_learner cl ON cl.learner_id = e.learner_id
JOIN events.session s ON s.id = e.session_id
JOIN events.event_registry r
  ON r.event_name = e.event_name AND r.event_version = e.event_version
WHERE r.exportable = true AND s.scorable = true;

-- Growth labels: the snapshot series a model would have to predict.
CREATE VIEW ml.v_growth_labels AS
SELECT cl.public_ref AS learner_ref,
       cl.grade_band,
       h.skill_code,
       h.snapshot_at,
       h.mastery,
       h.confidence,
       h.assist_index,
       h.evidence_count,
       h.growth_label,
       h.growth_kind,
       h.growth_delta,
       h.reason_codes,
       h.growth_model_version
FROM app.skill_state_history h
JOIN ml.v_consented_learner cl ON cl.learner_id = h.learner_id;
