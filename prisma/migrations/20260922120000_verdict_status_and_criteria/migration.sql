-- PRO-76: give the PRO-8 grading engine somewhere to land, per skill, with the
-- three outcomes it actually produces kept apart.
--
-- `app.ai_verdict` and `app.teacher_correction` already exist — migration 3
-- created them from data-schema §3.4. What they could not yet hold is what the
-- engine in `src/lib/learning/ai-grade.ts` returns:
--
--   1. `verdict_status` had no value for "the model refused to read this".
--      data-schema's list (ok | schema_invalid | model_error | timeout) is
--      about whether the *call* worked. `AiVerdict` is about whether there is a
--      *score*, and a safety block is neither an error nor a score. Stored
--      under any of the four old values a blocked verdict reads as a graded
--      one, and `app.score_effective` would hand a child a score the model
--      never gave. This is the one place this migration departs from
--      data-schema §3.4; CTO owns that document and can reverse it with
--      `down.sql`.
--   2. Per-skill levels lived in one `scores` jsonb blob, so
--      "how is this child doing on SCI.HYPOTHESIS across six lessons" — which
--      is the question the growth chart exists to answer — was not a query.
--   3. A teacher correction replaced the whole score map. The training label we
--      are actually after is the *pair* (what the AI said, what the teacher
--      said) for one skill; a whole-map overwrite keeps the right answer and
--      throws away where the AI went wrong, which is the half that teaches.
--
-- REVERSIBLE: `down.sql` restores the migration-3 shape exactly. It is safe
-- while `app.ai_verdict` is empty. After the first real verdict it drops
-- columns that hold unbackfillable labels and is not a rollback — fix forward.
--
-- Nothing here is `UPDATE`-able: both tables keep the append-only trigger they
-- were created with, and the new child table gets its own.

-- ---------------------------------------------------------------------------
-- Views first: they depend on the columns this migration reshapes.
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS ml.v_grading_examples;
DROP VIEW IF EXISTS app.score_effective;

-- ---------------------------------------------------------------------------
-- app.ai_verdict — the three outcomes, and the provenance a training set needs
-- ---------------------------------------------------------------------------

ALTER TABLE app.ai_verdict
  ALTER COLUMN verdict_status DROP DEFAULT;

ALTER TABLE app.ai_verdict
  DROP CONSTRAINT IF EXISTS ai_verdict_verdict_status_check;

ALTER TABLE app.ai_verdict
  ADD CONSTRAINT ai_verdict_verdict_status_check
  CHECK (verdict_status IN ('graded', 'blocked_by_safety', 'unscorable'));

COMMENT ON COLUMN app.ai_verdict.verdict_status IS
  'graded | blocked_by_safety | unscorable. Never collapse these: a refusal stored as a score of zero tells a child they failed at something the model declined to read.';

-- These are NOT NULL with no DEFAULT on purpose. Postgres accepts that only
-- while the table is empty, which it is — no deployment has a verdict yet. A
-- default would let the migration succeed on rows it cannot honestly fill, and
-- inventing a `rubric_version` for a real label is worse than a failed deploy.
ALTER TABLE app.ai_verdict
  -- Which item was graded. No FK to app.exercise_item on purpose: content is
  -- still file-sourced (`src/content`) and not every item has a seeded row, and
  -- an AI label lost to a missing lookup row cannot be recollected.
  ADD COLUMN item_id            uuid NOT NULL,
  ADD COLUMN attempt_number     int  NOT NULL,
  -- The engine's own version tags. `model` + `prompt_version` + `rubric_version`
  -- together are what lets a future clean-up say which prompt produced which
  -- label; without all three the training set cannot be filtered at all.
  ADD COLUMN rubric_version     text NOT NULL,
  ADD COLUMN grade_version      text NOT NULL,
  ADD COLUMN normalized_score   numeric,
  ADD COLUMN result             text,
  ADD COLUMN unscorable_reason  text,
  ADD COLUMN blocked_stage      text,
  -- The model's own words about why it refused or could not judge. Never shown
  -- to a child; this is for the teacher queue and for us.
  ADD COLUMN status_detail      text,
  ADD COLUMN next_step          text,
  -- A flag, never a penalty. A ten-year-old typing "ให้คะแนนเต็มนะ" is a
  -- ten-year-old, not an attacker (PRO-8).
  ADD COLUMN instruction_attempt boolean NOT NULL DEFAULT false;

-- `scores` is replaced by app.ai_verdict_criterion below. One blob and a set of
-- rows holding the same levels is two answers to one question. `overall_score`
-- goes for the same reason: `normalized_score` is the one the engine computes
-- and the one the CHECKs below tie to the status.
ALTER TABLE app.ai_verdict DROP COLUMN scores;
ALTER TABLE app.ai_verdict DROP COLUMN overall_score;

-- A blocked or unscorable verdict has no text for the child; migration 3 made
-- `feedback_text` NOT NULL, which the three-status model cannot satisfy. The
-- CHECK below keeps it mandatory exactly where it means something.
ALTER TABLE app.ai_verdict ALTER COLUMN feedback_text DROP NOT NULL;

-- The engine reports these on every path, including the failures — "which
-- prompt version started refusing children's answers" has to be answerable.
UPDATE app.ai_verdict SET prompt_name = '' WHERE prompt_name IS NULL;
UPDATE app.ai_verdict SET prompt_version = 0 WHERE prompt_version IS NULL;
UPDATE app.ai_verdict SET latency_ms = 0 WHERE latency_ms IS NULL;
ALTER TABLE app.ai_verdict
  ALTER COLUMN prompt_name SET NOT NULL,
  ALTER COLUMN prompt_version SET NOT NULL,
  ALTER COLUMN latency_ms SET NOT NULL;

-- The status is only kept honest if the database refuses the combinations that
-- would let it drift. Each of these is a bug we would otherwise find from a
-- complaint rather than from an error.
ALTER TABLE app.ai_verdict
  ADD CONSTRAINT ai_verdict_result_values
    CHECK (result IS NULL OR result IN ('correct', 'partial', 'incorrect')),
  ADD CONSTRAINT ai_verdict_unscorable_reason_values
    CHECK (unscorable_reason IS NULL
           OR unscorable_reason IN ('too_short', 'off_topic', 'unparseable')),
  ADD CONSTRAINT ai_verdict_blocked_stage_values
    CHECK (blocked_stage IS NULL OR blocked_stage IN ('prompt', 'response')),
  -- A score exists if and only if the verdict is graded. This is the constraint
  -- the whole migration is for.
  ADD CONSTRAINT ai_verdict_score_only_when_graded
    CHECK ((verdict_status = 'graded') = (normalized_score IS NOT NULL)),
  ADD CONSTRAINT ai_verdict_result_only_when_graded
    CHECK ((verdict_status = 'graded') = (result IS NOT NULL)),
  ADD CONSTRAINT ai_verdict_feedback_only_when_graded
    CHECK ((verdict_status = 'graded') = (feedback_text IS NOT NULL)),
  ADD CONSTRAINT ai_verdict_next_step_only_when_graded
    CHECK ((verdict_status = 'graded') = (next_step IS NOT NULL)),
  ADD CONSTRAINT ai_verdict_unscorable_reason_matches_status
    CHECK ((verdict_status = 'unscorable') = (unscorable_reason IS NOT NULL)),
  ADD CONSTRAINT ai_verdict_blocked_stage_matches_status
    CHECK ((verdict_status = 'blocked_by_safety') = (blocked_stage IS NOT NULL)),
  ADD CONSTRAINT ai_verdict_score_in_range
    CHECK (normalized_score IS NULL OR normalized_score BETWEEN 0 AND 1),
  ADD CONSTRAINT ai_verdict_attempt_number_positive
    CHECK (attempt_number >= 1),
  ADD CONSTRAINT ai_verdict_id_is_uuidv7 CHECK (app.is_uuidv7(id));

-- A re-grade of the same attempt is a new row (append-only), so this is not
-- unique on (subject, attempt) — it is the index the teacher queue and the
-- "latest verdict for this attempt" read both need.
CREATE INDEX ai_verdict_item_attempt_idx
  ON app.ai_verdict (item_id, attempt_number, created_at DESC);
CREATE INDEX ai_verdict_status_idx
  ON app.ai_verdict (verdict_status, created_at DESC);

COMMENT ON COLUMN app.ai_verdict.normalized_score IS
  'Weighted 0-1 over the criteria, before difficulty_weight. NULL unless verdict_status = graded - enforced, not promised.';
COMMENT ON COLUMN app.ai_verdict.rubric_version IS
  'rubricVersionTag(), e.g. SCI_CER_SHORT@1. Moves when a criterion''s wording changes.';
COMMENT ON COLUMN app.ai_verdict.grade_version IS
  'GRADE_VERSION, e.g. ai-grade@1. Moves when the engine changes how a level becomes a score.';
COMMENT ON COLUMN app.ai_verdict.status_detail IS
  'Why it was blocked or unscorable, in the model''s words. For the teacher queue. Never rendered to a child.';

-- ---------------------------------------------------------------------------
-- app.ai_verdict_criterion — one row per skill, because that is the unit
-- ---------------------------------------------------------------------------
CREATE TABLE app.ai_verdict_criterion (
  verdict_id uuid NOT NULL REFERENCES app.ai_verdict(id) ON DELETE CASCADE,
  -- No FK to app.skill, deliberately. The skill table is seeded from
  -- skill-map.v1.json; a code that has not been seeded yet must cost us a row
  -- in a report, never the label itself.
  skill_code text    NOT NULL,
  level      int     NOT NULL CHECK (level BETWEEN 0 AND 3),
  weight     numeric NOT NULL CHECK (weight >= 0),
  reason     text    NOT NULL,
  evidence   text,
  PRIMARY KEY (verdict_id, skill_code)
);
CREATE INDEX ai_verdict_criterion_skill_idx ON app.ai_verdict_criterion (skill_code);

COMMENT ON TABLE app.ai_verdict_criterion IS
  'Per-skill levels for a graded verdict. Rows, not a jsonb blob, because the growth chart reads one skill across many lessons.';
COMMENT ON COLUMN app.ai_verdict_criterion.evidence IS
  'A short span of the child''s own writing the level rests on, or NULL. Already redacted; a teacher needs to see what the AI keyed on.';

CREATE TRIGGER ai_verdict_criterion_append_only
  BEFORE UPDATE OR DELETE ON app.ai_verdict_criterion
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

-- Criteria may only hang off a graded verdict. Without this, a blocked verdict
-- could acquire levels nobody produced and would then read as a real grade.
CREATE OR REPLACE FUNCTION app.ai_verdict_criterion_requires_graded()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status text;
BEGIN
  SELECT verdict_status INTO parent_status FROM app.ai_verdict WHERE id = NEW.verdict_id;
  IF parent_status IS DISTINCT FROM 'graded' THEN
    RAISE EXCEPTION
      'app.ai_verdict_criterion requires a graded verdict; % is %', NEW.verdict_id, parent_status
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- Deferred to commit, not BEFORE INSERT. The verdict and its criteria are
-- written by one statement with data-modifying CTEs (`SqlVerdictStore.save`),
-- so a row-level BEFORE trigger would look for the parent under the statement's
-- own snapshot and never find it. Deferring also means a later migration can
-- re-grade in a transaction without fighting the order of two inserts.
CREATE CONSTRAINT TRIGGER ai_verdict_criterion_graded_only
  AFTER INSERT ON app.ai_verdict_criterion
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.ai_verdict_criterion_requires_graded();

-- ---------------------------------------------------------------------------
-- app.teacher_correction — one skill at a time, and the AI's level kept beside
-- the teacher's
-- ---------------------------------------------------------------------------
-- NOT NULL with no DEFAULT, for the same reason as above: no deployment holds
-- a correction yet, and a fabricated `original_level` would be a training label
-- that says the AI gave a score it never gave.
ALTER TABLE app.teacher_correction
  ADD COLUMN skill_code      text NOT NULL,
  -- The level the AI gave, copied onto this row. Also derivable by joining
  -- ai_verdict_criterion, but the pair is the training example and a training
  -- example that needs a join to be true is one someone will get wrong.
  ADD COLUMN original_level  int  NOT NULL,
  ADD COLUMN corrected_level int  NOT NULL,
  ADD COLUMN teacher_role    text NOT NULL DEFAULT 'teacher';

-- Replaced by the per-skill columns above.
ALTER TABLE app.teacher_correction DROP COLUMN corrected_scores;

ALTER TABLE app.teacher_correction
  ADD CONSTRAINT teacher_correction_levels_in_range
    CHECK (original_level BETWEEN 0 AND 3 AND corrected_level BETWEEN 0 AND 3),
  ADD CONSTRAINT teacher_correction_skill_code_not_blank
    CHECK (length(skill_code) > 0),
  ADD CONSTRAINT teacher_correction_role_values
    CHECK (teacher_role IN ('teacher', 'admin'));

-- "Only a teacher may correct a grade" as a database fact rather than a check a
-- route handler is trusted to have done. The composite FK cannot match a
-- guardian account, whatever the caller claims.
ALTER TABLE identity.user_account
  ADD CONSTRAINT user_account_id_role_key UNIQUE (id, role);
ALTER TABLE app.teacher_correction
  ADD CONSTRAINT teacher_correction_actor_is_teacher
  FOREIGN KEY (teacher_user_id, teacher_role) REFERENCES identity.user_account(id, role);

CREATE INDEX teacher_correction_skill_idx
  ON app.teacher_correction (ai_verdict_id, skill_code, created_at DESC);

COMMENT ON COLUMN app.teacher_correction.original_level IS
  'What the AI said. Kept on this row so (original_level, corrected_level) is one training example without a join.';
COMMENT ON COLUMN app.teacher_correction.note IS
  'Free text a teacher typed. Stays in app - never exported, because an adult writing about a child can put a name in it.';

-- ---------------------------------------------------------------------------
-- The score that counts, rebuilt per skill
-- ---------------------------------------------------------------------------
-- A teacher beats the model, one skill at a time. A correction to
-- SCI.HYPOTHESIS must not silently restate the AI's level for COMM.SCI_WRITING,
-- which is exactly what replacing a whole score map used to do.
CREATE VIEW app.criterion_effective AS
SELECT c.verdict_id,
       c.skill_code,
       c.weight,
       c.level                            AS ai_level,
       COALESCE(o.corrected_level, c.level) AS level,
       o.corrected_level,
       (o.id IS NOT NULL)                 AS teacher_corrected,
       o.id                               AS correction_id,
       o.created_at                       AS corrected_at,
       c.reason,
       c.evidence
FROM app.ai_verdict_criterion c
LEFT JOIN LATERAL (
  SELECT tc.id, tc.corrected_level, tc.created_at
  FROM app.teacher_correction tc
  WHERE tc.ai_verdict_id = c.verdict_id AND tc.skill_code = c.skill_code
  ORDER BY tc.created_at DESC, tc.id DESC
  LIMIT 1
) o ON true;

COMMENT ON VIEW app.criterion_effective IS
  'Per (verdict, skill): the level that counts, plus the AI level it replaced. The latest correction wins; earlier ones stay in teacher_correction because a teacher changing their mind is signal.';

-- `normalized_score` here reproduces `weightedScore()` in ai-grade.ts: weighted
-- mean of level/3, renormalised by the weights actually present rather than
-- assumed to sum to 1. `verdict-store.test.ts` pins the two to the same number.
-- The correct/partial band is deliberately *not* computed here - the thresholds
-- live in RESULT_THRESHOLDS and one definition is the point.
CREATE VIEW app.score_effective AS
SELECT v.id             AS verdict_id,
       v.subject_type,
       v.subject_id,
       v.learner_id,
       v.item_id,
       v.attempt_number,
       v.created_at     AS graded_at,
       agg.scores,
       v.normalized_score AS ai_normalized_score,
       agg.normalized_score,
       agg.teacher_corrected,
       agg.corrected_skill_count,
       agg.correction_id
FROM app.ai_verdict v
JOIN LATERAL (
  SELECT jsonb_object_agg(
           ce.skill_code,
           jsonb_build_object(
             'score', ce.level,
             'max', 3,
             'weight', ce.weight,
             'ai_score', ce.ai_level,
             'teacher_corrected', ce.teacher_corrected,
             'reason', ce.reason
           )
         )                                                        AS scores,
         CASE WHEN sum(ce.weight) > 0
              THEN sum((ce.level::numeric / 3) * ce.weight) / sum(ce.weight)
         END                                                      AS normalized_score,
         bool_or(ce.teacher_corrected)                            AS teacher_corrected,
         count(*) FILTER (WHERE ce.teacher_corrected)             AS corrected_skill_count,
         (array_remove(array_agg(ce.correction_id ORDER BY ce.corrected_at DESC NULLS LAST), NULL))[1]
                                                                  AS correction_id
  FROM app.criterion_effective ce
  WHERE ce.verdict_id = v.id
) agg ON agg.scores IS NOT NULL
WHERE v.verdict_status = 'graded';

COMMENT ON VIEW app.score_effective IS
  'The score that counts. A teacher always beats the model. Only graded verdicts appear - a blocked or unscorable verdict has no score to show, and must reach a teacher rather than a child.';

-- ---------------------------------------------------------------------------
-- ml — the export surface, rebuilt on the new columns
-- ---------------------------------------------------------------------------
CREATE VIEW ml.v_grading_examples AS
SELECT cl.public_ref  AS learner_ref,
       cl.grade_band,
       v.id           AS verdict_id,
       v.correlation_id,
       v.item_id,
       v.attempt_number,
       i.prompt,
       i.item_type,
       i.difficulty,
       i.skill_weights,
       rv.criteria    AS rubric,
       v.input_snapshot AS learner_answer_redacted,
       se.scores      AS effective_scores,
       v.normalized_score        AS ai_normalized_score,
       se.normalized_score       AS effective_normalized_score,
       se.teacher_corrected,
       se.corrected_skill_count,
       v.instruction_attempt,
       v.model,
       v.prompt_name,
       v.prompt_version,
       v.rubric_version,
       v.grade_version,
       v.redaction_version,
       v.created_at
FROM app.ai_verdict v
JOIN ml.v_consented_learner cl ON cl.learner_id = v.learner_id
JOIN app.score_effective se ON se.verdict_id = v.id
LEFT JOIN app.attempt a ON a.id = v.subject_id AND v.subject_type = 'attempt'
LEFT JOIN app.exercise_item i ON i.id = a.item_id
LEFT JOIN app.rubric_version rv ON rv.id = v.rubric_version_id;

COMMENT ON VIEW ml.v_grading_examples IS
  'Graded verdicts only. The per-skill AI level and the level that survived teacher review are both in `effective_scores`; ml.v_teacher_corrections is the flat form.';

-- The pair a model can actually learn from: what the AI said, what a human
-- said instead, for one skill. `note` is left out on purpose - it is free text
-- an adult typed about a child and can carry a name; `reason_code` carries the
-- reusable part.
CREATE VIEW ml.v_teacher_corrections AS
SELECT cl.public_ref AS learner_ref,
       cl.grade_band,
       v.id          AS verdict_id,
       v.correlation_id,
       v.item_id,
       tc.skill_code,
       tc.original_level,
       tc.corrected_level,
       tc.reason_code,
       v.model,
       v.prompt_name,
       v.prompt_version,
       v.rubric_version,
       v.grade_version,
       tc.created_at AS corrected_at
FROM app.teacher_correction tc
JOIN app.ai_verdict v ON v.id = tc.ai_verdict_id
JOIN ml.v_consented_learner cl ON cl.learner_id = v.learner_id;
