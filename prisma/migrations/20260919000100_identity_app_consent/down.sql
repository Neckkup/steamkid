-- Reverse of 20260919000100_identity_app_consent.
--
-- Safe while the four schemas are empty (they are, until the first learner
-- signs up). After that this deletes production data and is NOT the rollback
-- path: the forward fix is a new migration.
--
-- Run 20260919000300's down.sql and 20260919000200's down.sql first.

DROP SCHEMA IF EXISTS ml CASCADE;
DROP SCHEMA IF EXISTS events CASCADE;
DROP SCHEMA IF EXISTS identity CASCADE;
DROP SCHEMA IF EXISTS app CASCADE;
