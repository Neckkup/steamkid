-- Add a monotonically-increasing sequence column to app.teacher_correction so
-- that listOverrides returns rows in deterministic insertion order even when
-- two corrections share the same created_at timestamp (common in fast tests
-- and high-throughput write paths).
--
-- Reversible: DROP COLUMN seq; recreate old index.

ALTER TABLE app.teacher_correction
  ADD COLUMN seq bigserial NOT NULL;

-- Replace the old index (which only covered created_at DESC) with one that
-- also includes seq so the ORDER BY seq ASC plan is fully index-supported.
DROP INDEX IF EXISTS app.teacher_correction_verdict_idx;
CREATE INDEX teacher_correction_verdict_idx
  ON app.teacher_correction (ai_verdict_id, seq ASC);
