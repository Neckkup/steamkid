-- backup-manifest.sql — the fingerprint a restore is checked against.
--
-- Run against the SOURCE database at dump time, and against the RESTORED drill
-- instance afterwards. Identical output on both sides is the pass condition for
-- the restore drill in docs/runbooks/postgres-backup-restore.md §5.
--
-- Counts and timestamps only. No child data leaves the database through this
-- file, which is why the manifest may be stored unencrypted next to the dump.
--
-- Usage:
--   psql "$DIRECT_URL" -At -F',' -f scripts/sql/backup-manifest.sql > steamkid-<stamp>.manifest.csv

\pset footer off

-- 1. Object inventory: every schema and its table count.
SELECT 'inventory' AS section, table_schema AS key, count(*)::text AS value
FROM information_schema.tables
WHERE table_schema IN ('identity', 'app', 'events', 'ml')
GROUP BY table_schema
ORDER BY table_schema;

-- 2. Row counts for the tables whose loss would be unrecoverable.
SELECT 'rowcount' AS section, t AS key, n::text AS value
FROM (
  SELECT 'app.learner' AS t, count(*) AS n FROM app.learner
  UNION ALL SELECT 'app.consent_record',        count(*) FROM app.consent_record
  UNION ALL SELECT 'identity.learner_profile',  count(*) FROM identity.learner_profile
  UNION ALL SELECT 'identity.user_account',     count(*) FROM identity.user_account
  UNION ALL SELECT 'identity.pii_access_log',   count(*) FROM identity.pii_access_log
  UNION ALL SELECT 'events.session',            count(*) FROM events.session
  UNION ALL SELECT 'events.behavior_event',     count(*) FROM events.behavior_event
  UNION ALL SELECT 'events.event_registry',     count(*) FROM events.event_registry
  UNION ALL SELECT 'events.dead_letter',        count(*) FROM events.dead_letter
  UNION ALL SELECT 'app.submission',            count(*) FROM app.submission
  UNION ALL SELECT 'app.submission_draft',      count(*) FROM app.submission_draft
  UNION ALL SELECT 'app.ai_verdict',            count(*) FROM app.ai_verdict
  UNION ALL SELECT 'app.ai_verdict_criterion',  count(*) FROM app.ai_verdict_criterion
  UNION ALL SELECT 'app.teacher_correction',    count(*) FROM app.teacher_correction
) c
ORDER BY t;

-- 3. The point in time the backup actually reached.
SELECT 'watermark' AS section, 'events.behavior_event.max_event_time' AS key,
       coalesce(max(event_time)::text, 'empty') AS value
FROM events.behavior_event;

-- 4. Partitions survived as partitions, not as one flat table.
SELECT 'partition' AS section, c.relname AS key, '' AS value
FROM pg_inherits i
JOIN pg_class c ON c.oid = i.inhrelid
JOIN pg_class p ON p.oid = i.inhparent
WHERE p.relname = 'behavior_event'
ORDER BY c.relname;

-- 5. The join the whole dataset exists for still resolves end to end.
SELECT 'view' AS section, 'ml.v_grading_examples' AS key, count(*)::text AS value
FROM ml.v_grading_examples;

-- 6. Consent gating is structural: an export view must not expose a learner
--    without an active training_use consent. Must be 0 on both sides.
SELECT 'invariant' AS section, 'unconsented_leaks' AS key, count(*)::text AS value
FROM ml.v_consented_learner v
WHERE NOT EXISTS (
  SELECT 1 FROM app.consent_current c
  WHERE c.learner_id = v.learner_id
    AND c.scope = 'training_use'
    AND c.granted
);
