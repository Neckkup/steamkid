-- Reverse of 20260923100000_partition_runway.
--
-- Fully reversible and safe at any time: this drops only the maintenance
-- helpers. Partitions this migration created are left in place on purpose —
-- dropping them would destroy behaviour events, which is never a rollback.

DROP VIEW IF EXISTS events.partition_runway;
DROP FUNCTION IF EXISTS events.ensure_partition_runway(int);
