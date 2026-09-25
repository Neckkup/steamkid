-- Reverse of 20260925120000_pg_learning_store.
--
-- Drops app.learner_consent_cache and the columns added to app.attempt and
-- app.submission. Safe only while those columns/table are empty.
--
-- NOTE: session_id NOT NULL, the item_id FK on app.attempt, and the lesson_id
-- FK on app.submission are NOT restored here. Restoring them after data has
-- been written would violate the constraints on existing rows. Fix forward
-- with a new migration if those constraints are needed again.

DROP TABLE IF EXISTS app.learner_consent_cache;

ALTER TABLE app.submission
  DROP COLUMN IF EXISTS item_id;

ALTER TABLE app.attempt
  DROP COLUMN IF EXISTS normalized_score,
  DROP COLUMN IF EXISTS result,
  DROP COLUMN IF EXISTS pending_ai,
  DROP COLUMN IF EXISTS source,
  DROP COLUMN IF EXISTS lesson_id;
