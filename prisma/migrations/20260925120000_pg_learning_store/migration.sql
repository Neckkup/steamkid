-- PRO-169: extend app.* tables so the Postgres-backed LearningStore can write
-- consent, attempts and submissions without a content registry or guardian auth.
--
-- REVERSIBLE: down.sql drops the new table and columns. Safe only while they
-- are empty; after the first learner the added columns hold unbackfillable data
-- and the forward fix is a new migration.
--
-- Design decisions (three separate concerns):
--
-- app.attempt
--   session_id was NOT NULL but the current code path does not always supply
--   one; make it nullable. item_id's foreign key is dropped for the same reason
--   app.ai_verdict.item_id has no FK: content is file-sourced, and losing a
--   label to a missing lookup row cannot be undone. started_at gets a default
--   of now() because AttemptRecord carries only submitted_at. answer_hash is
--   nullable because the app code does not compute it. Four columns are added
--   to carry the fields AttemptRecord holds that the original schema did not.
--
-- app.submission
--   lesson_id's FK is dropped (same file-sourced reason as attempt.item_id).
--   item_id is added because SubmissionRecord.itemId exists and listSubmissions
--   needs to filter/group by it. content gets a safe default so the column
--   remains NOT NULL while new rows can be inserted without an explicit value.
--
-- app.learner_consent_cache
--   A simple upsertable table for the pre-guardian-auth consent flow. The
--   authoritative app.consent_record requires a guardian FK that does not exist
--   yet; this table bridges the gap until the full auth layer lands.

-- -------------------------------------------------------------------------
-- app.attempt — relax constraints that block the current code path
-- -------------------------------------------------------------------------

-- Not every path has a session id yet; make nullable (keep column for join).
ALTER TABLE app.attempt
  ALTER COLUMN session_id DROP NOT NULL;

-- item_id: drop FK (content is file-sourced, same decision as ai_verdict.item_id).
-- Column stays NOT NULL — we always have an item id from the route.
ALTER TABLE app.attempt
  DROP CONSTRAINT IF EXISTS attempt_item_id_fkey;

-- started_at: default to now() so routes that only track submitted_at still work.
ALTER TABLE app.attempt
  ALTER COLUMN started_at SET DEFAULT now();

-- answer_hash: not computed by application code.
ALTER TABLE app.attempt
  ALTER COLUMN answer_hash DROP NOT NULL;

-- Fields carried by AttemptRecord that the original schema did not have.
ALTER TABLE app.attempt
  ADD COLUMN IF NOT EXISTS lesson_id        uuid,
  ADD COLUMN IF NOT EXISTS source           text    NOT NULL DEFAULT 'deterministic'
                           CHECK (source IN ('deterministic', 'ai')),
  ADD COLUMN IF NOT EXISTS pending_ai       boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS result           text    CHECK (result IS NULL OR result IN ('correct', 'partial', 'incorrect')),
  ADD COLUMN IF NOT EXISTS normalized_score numeric CHECK (normalized_score IS NULL OR (normalized_score BETWEEN 0 AND 1));

COMMENT ON COLUMN app.attempt.lesson_id IS
  'The lesson this attempt belongs to. No FK — lesson ids are file-sourced and may not be seeded.';
COMMENT ON COLUMN app.attempt.source IS
  'deterministic (rule-based grader) or ai (Gemini grader). Copied from AttemptRecord.';
COMMENT ON COLUMN app.attempt.pending_ai IS
  'True when the attempt is awaiting AI grading. Never set to true by the deterministic grader.';

-- -------------------------------------------------------------------------
-- app.submission — drop FK, add item_id
-- -------------------------------------------------------------------------

-- lesson_id: drop FK (same file-sourced reason as attempt.item_id above).
ALTER TABLE app.submission
  DROP CONSTRAINT IF EXISTS submission_lesson_id_fkey;

-- item_id needed because SubmissionRecord carries it and listSubmissions groups by it.
ALTER TABLE app.submission
  ADD COLUMN IF NOT EXISTS item_id uuid;

COMMENT ON COLUMN app.submission.item_id IS
  'The exercise item this submission answers. No FK — item ids are file-sourced.';

-- Give content a safe default so the column stays NOT NULL while new inserts
-- can omit it. In practice the store always provides a value.
ALTER TABLE app.submission
  ALTER COLUMN content SET DEFAULT 'null'::jsonb;

-- -------------------------------------------------------------------------
-- app.learner_consent_cache — pre-auth consent state
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.learner_consent_cache (
  learner_id     uuid        PRIMARY KEY REFERENCES app.learner(id) ON DELETE CASCADE,
  policy_version text        NOT NULL,
  scopes         text[]      NOT NULL,
  granted_at     timestamptz NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE app.learner_consent_cache IS
  'Working consent state for the pre-guardian-auth flow. '
  'Upsertable: a new grant is ON CONFLICT DO UPDATE, withdrawal is DELETE. '
  'Replaced by app.consent_record once guardian accounts exist.';
