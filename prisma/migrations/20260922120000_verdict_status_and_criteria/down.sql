-- Reverse of 20260922120000_verdict_status_and_criteria.
--
-- Restores the migration-3 (data-schema §3.4) shape of app.ai_verdict and
-- app.teacher_correction exactly: the four-value `verdict_status`, the `scores`
-- and `corrected_scores` jsonb columns, and the original `app.score_effective`
-- and `ml.v_grading_examples`.
--
-- Safe only while app.ai_verdict is empty. Per-skill levels and the
-- (original_level, corrected_level) pairs are the labels this whole ticket
-- exists to keep, and they do not fit back into a jsonb blob without loss — so
-- after the first real verdict the forward fix is a new migration, not this.

DROP VIEW IF EXISTS ml.v_teacher_corrections;
DROP VIEW IF EXISTS ml.v_grading_examples;
DROP VIEW IF EXISTS app.score_effective;
DROP VIEW IF EXISTS app.criterion_effective;

DROP TRIGGER IF EXISTS ai_verdict_criterion_graded_only ON app.ai_verdict_criterion;
DROP TRIGGER IF EXISTS ai_verdict_criterion_append_only ON app.ai_verdict_criterion;
DROP TABLE IF EXISTS app.ai_verdict_criterion;
DROP FUNCTION IF EXISTS app.ai_verdict_criterion_requires_graded();

-- teacher_correction
ALTER TABLE app.teacher_correction
  DROP CONSTRAINT IF EXISTS teacher_correction_actor_is_teacher;
ALTER TABLE identity.user_account
  DROP CONSTRAINT IF EXISTS user_account_id_role_key;

DROP INDEX IF EXISTS app.teacher_correction_skill_idx;

ALTER TABLE app.teacher_correction
  DROP CONSTRAINT IF EXISTS teacher_correction_levels_in_range,
  DROP CONSTRAINT IF EXISTS teacher_correction_skill_code_not_blank,
  DROP CONSTRAINT IF EXISTS teacher_correction_role_values;

ALTER TABLE app.teacher_correction
  DROP COLUMN IF EXISTS skill_code,
  DROP COLUMN IF EXISTS original_level,
  DROP COLUMN IF EXISTS corrected_level,
  DROP COLUMN IF EXISTS teacher_role;

ALTER TABLE app.teacher_correction
  ADD COLUMN corrected_scores jsonb NOT NULL DEFAULT '{}';
ALTER TABLE app.teacher_correction
  ALTER COLUMN corrected_scores DROP DEFAULT;

-- ai_verdict
DROP INDEX IF EXISTS app.ai_verdict_item_attempt_idx;
DROP INDEX IF EXISTS app.ai_verdict_status_idx;

ALTER TABLE app.ai_verdict
  DROP CONSTRAINT IF EXISTS ai_verdict_result_values,
  DROP CONSTRAINT IF EXISTS ai_verdict_unscorable_reason_values,
  DROP CONSTRAINT IF EXISTS ai_verdict_blocked_stage_values,
  DROP CONSTRAINT IF EXISTS ai_verdict_score_only_when_graded,
  DROP CONSTRAINT IF EXISTS ai_verdict_result_only_when_graded,
  DROP CONSTRAINT IF EXISTS ai_verdict_feedback_only_when_graded,
  DROP CONSTRAINT IF EXISTS ai_verdict_next_step_only_when_graded,
  DROP CONSTRAINT IF EXISTS ai_verdict_unscorable_reason_matches_status,
  DROP CONSTRAINT IF EXISTS ai_verdict_blocked_stage_matches_status,
  DROP CONSTRAINT IF EXISTS ai_verdict_score_in_range,
  DROP CONSTRAINT IF EXISTS ai_verdict_attempt_number_positive,
  DROP CONSTRAINT IF EXISTS ai_verdict_id_is_uuidv7;

ALTER TABLE app.ai_verdict
  DROP COLUMN IF EXISTS item_id,
  DROP COLUMN IF EXISTS attempt_number,
  DROP COLUMN IF EXISTS rubric_version,
  DROP COLUMN IF EXISTS grade_version,
  DROP COLUMN IF EXISTS normalized_score,
  DROP COLUMN IF EXISTS result,
  DROP COLUMN IF EXISTS unscorable_reason,
  DROP COLUMN IF EXISTS blocked_stage,
  DROP COLUMN IF EXISTS status_detail,
  DROP COLUMN IF EXISTS next_step,
  DROP COLUMN IF EXISTS instruction_attempt;

ALTER TABLE app.ai_verdict
  ADD COLUMN scores jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN overall_score numeric;
ALTER TABLE app.ai_verdict
  ALTER COLUMN scores DROP DEFAULT;

ALTER TABLE app.ai_verdict
  ALTER COLUMN prompt_name DROP NOT NULL,
  ALTER COLUMN prompt_version DROP NOT NULL,
  ALTER COLUMN latency_ms DROP NOT NULL;

UPDATE app.ai_verdict SET feedback_text = '' WHERE feedback_text IS NULL;
ALTER TABLE app.ai_verdict ALTER COLUMN feedback_text SET NOT NULL;

ALTER TABLE app.ai_verdict
  DROP CONSTRAINT IF EXISTS ai_verdict_verdict_status_check;
UPDATE app.ai_verdict SET verdict_status = 'ok' WHERE verdict_status = 'graded';
UPDATE app.ai_verdict SET verdict_status = 'model_error'
  WHERE verdict_status IN ('blocked_by_safety', 'unscorable');
ALTER TABLE app.ai_verdict
  ADD CONSTRAINT ai_verdict_verdict_status_check
  CHECK (verdict_status IN ('ok', 'schema_invalid', 'model_error', 'timeout'));
ALTER TABLE app.ai_verdict ALTER COLUMN verdict_status SET DEFAULT 'ok';

-- The migration-3 views, verbatim.
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
