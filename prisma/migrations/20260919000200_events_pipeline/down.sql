-- Reverse of 20260919000200_events_pipeline.
--
-- Safe only while events.behavior_event is empty. Behaviour events cannot be
-- re-collected, so after the first real session this is data destruction, not
-- a rollback; fix forward with a new migration instead.

DROP TABLE IF EXISTS events.dead_letter;
DROP TABLE IF EXISTS events.event_registry;
DROP TABLE IF EXISTS events.behavior_event CASCADE; -- takes its partitions with it
DROP FUNCTION IF EXISTS events.ensure_month_partition(date);
DROP TABLE IF EXISTS events.session;
