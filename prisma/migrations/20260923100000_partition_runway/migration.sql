-- Keep the behaviour pipe's partition runway ahead of now(), and make running
-- out of runway loud instead of fatal.
--
-- REVERSIBLE: `down.sql` drops only what this migration adds. It never drops a
-- partition, so it cannot destroy behaviour events.
--
-- Why this exists (PRO-68 step 6). Migration 2 called
-- `events.ensure_month_partition` four times *at deploy time* and nothing has
-- called it since. On the real database that bought partitions through
-- 2026-11-30 and no further. There is deliberately no DEFAULT partition, so the
-- first event of the first uncovered month does not get dead-lettered as
-- `implausible_event_time` — the gate finds its clock perfectly plausible and
-- the INSERT dies with `no partition of relation "behavior_event" found for
-- row` (SQLSTATE 23514), failing the whole batch with a 500.
--
-- Behaviour events cannot be backfilled from a child's tablet, so "a scheduler
-- did not run" must not be a way to lose them.

-- ---------------------------------------------------------------------------
-- events.ensure_partition_runway(months int)
-- ---------------------------------------------------------------------------
-- Idempotent, and the single call any scheduler needs. Covers last month (the
-- gate accepts an event_time up to 7 days old, which can cross a boundary),
-- this month, and `months` months ahead.
CREATE OR REPLACE FUNCTION events.ensure_partition_runway(months int DEFAULT 3)
RETURNS TABLE (partition_name text, created boolean)
LANGUAGE plpgsql
AS $$
DECLARE
  offset_months int;
  month_start   date;
  name          text;
  existed       boolean;
BEGIN
  IF months < 1 THEN
    RAISE EXCEPTION 'months must be at least 1, got %', months;
  END IF;

  FOR offset_months IN -1..months LOOP
    month_start := (date_trunc('month', now()) + make_interval(months => offset_months))::date;
    name := format('behavior_event_%s', to_char(month_start, 'YYYYMM'));

    existed := to_regclass(format('events.%I', name)) IS NOT NULL;
    PERFORM events.ensure_month_partition(month_start);

    partition_name := name;
    created := NOT existed;
    RETURN NEXT;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION events.ensure_partition_runway(int) IS
  'Idempotent partition maintenance. Run monthly (scripts/ensure-partitions.ts, npm run db:partitions) and on every deploy. Returns one row per month covered, with created = true for the ones it had to make.';

-- ---------------------------------------------------------------------------
-- events.partition_runway
-- ---------------------------------------------------------------------------
-- So "are we about to fall off the end?" is a query a monitor can run, not
-- something only discovered by a 500 on the first of the month.
CREATE OR REPLACE VIEW events.partition_runway AS
SELECT
  max(upper(pg_catalog.pg_get_expr(c.relpartbound, c.oid)::text)) IS NOT NULL AS has_partitions,
  max(((regexp_match(c.relname, '(\d{6})$'))[1])::text) AS last_month_covered,
  (to_date(max(((regexp_match(c.relname, '(\d{6})$'))[1])::text), 'YYYYMM')
     + interval '1 month')::date AS covered_until,
  (to_date(max(((regexp_match(c.relname, '(\d{6})$'))[1])::text), 'YYYYMM')
     + interval '1 month')::date - current_date AS days_of_runway
FROM pg_class c
JOIN pg_inherits i ON i.inhrelid = c.oid
JOIN pg_class p ON p.oid = i.inhparent
WHERE p.relname = 'behavior_event';

COMMENT ON VIEW events.partition_runway IS
  'How many days before events.behavior_event has no partition to accept a row. Alert below ~30 days; below 0 ingestion returns 500.';

-- Extend the runway now, from this deploy.
SELECT * FROM events.ensure_partition_runway(3);
