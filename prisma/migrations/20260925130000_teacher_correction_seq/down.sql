-- Reverse of 20260925130000_teacher_correction_seq.
--
-- Restores the original index. Safe to run while the table has data; the seq
-- column is dropped and existing queries fall back to (created_at, id) order.

DROP INDEX IF EXISTS app.teacher_correction_verdict_idx;
CREATE INDEX teacher_correction_verdict_idx
  ON app.teacher_correction (ai_verdict_id, created_at DESC);

ALTER TABLE app.teacher_correction
  DROP COLUMN IF EXISTS seq;
