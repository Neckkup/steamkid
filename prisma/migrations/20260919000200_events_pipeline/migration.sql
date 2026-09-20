-- Migration 2 of 3 for PRO-7: the behaviour pipe.
--
-- Source of truth: PRO-3 `data-schema` v1.1.0 §4 and §4.1.
--
-- REVERSIBLE: `down.sql` drops the four events tables and their partitions.
-- Safe while empty. Once events are flowing, the forward fix is a new
-- migration — behaviour events are unbackfillable, so dropping is never a
-- rollback.
--
-- Two deliberate departures from the §4 sketch, both tightening it:
--
--   1. `dead_letter` stores `payload_shape` (field names, types, lengths) and
--      `detail` (field paths and violated keywords) instead of `raw jsonb`.
--      PRO-22 closed this: an event is dead-lettered *because* something in it
--      looked like a child's typed answer, and copying it verbatim into a
--      second append-only table moves the leak rather than closing it.
--   2. `behavior_event` carries a CHECK that `event_time` really is the UUIDv7
--      timestamp of `event_id`. §4.1 needs that equality to hold for the PK to
--      enforce the stated `(learner_id, event_id)` de-duplication rule; a CHECK
--      makes the database hold it instead of every future ingest path promising
--      to.

-- ---------------------------------------------------------------------------
-- events.session — one row per reconstructed session
-- ---------------------------------------------------------------------------
-- `active_ms` is written by the server from `reconstructSession()`
-- (`src/lib/events/session-window.ts`), never copied from the client. Growth
-- formulas read `active_ms`; nothing scores `duration_ms`. An open tab is not
-- learning time.
CREATE TABLE events.session (
  id                uuid PRIMARY KEY,
  learner_id        uuid NOT NULL REFERENCES app.learner(id),
  started_at        timestamptz NOT NULL,
  ended_at          timestamptz,
  end_reason        text NOT NULL DEFAULT 'open' CHECK (end_reason IN (
                      'open', 'explicit_logout', 'timeout', 'navigate_away', 'crash', 'idle_close')),
  duration_ms       bigint NOT NULL DEFAULT 0,
  active_ms         bigint NOT NULL DEFAULT 0,
  client_active_ms  bigint,
  discarded_ms      bigint NOT NULL DEFAULT 0,
  scorable          boolean NOT NULL DEFAULT false,
  event_count       int NOT NULL DEFAULT 0,
  heartbeat_count   int NOT NULL DEFAULT 0,
  anomalies         jsonb NOT NULL DEFAULT '[]',
  device_class      text,
  ua_family         text,
  app_version       text,
  ip_hash           text,
  clock_skew_ms     int NOT NULL DEFAULT 0,
  reconstructed_at  timestamptz,
  CONSTRAINT session_id_is_uuidv7 CHECK (app.is_uuidv7(id)),
  CONSTRAINT session_active_within_duration CHECK (active_ms <= duration_ms + 60000)
);
CREATE INDEX session_learner_idx ON events.session (learner_id, started_at DESC);

COMMENT ON COLUMN events.session.active_ms IS
  'Server-authoritative active time from reconstructSession(). The only duration any score may read.';
COMMENT ON COLUMN events.session.duration_ms IS
  'Wall-clock span, context only. Never score on this - a tab left open is not reading.';
COMMENT ON COLUMN events.session.ip_hash IS
  'HMAC-SHA256(ip, rotating salt). A raw IP never reaches this table.';

-- ---------------------------------------------------------------------------
-- events.behavior_event — append-only, monthly partitions
-- ---------------------------------------------------------------------------
CREATE TABLE events.behavior_event (
  event_id               uuid NOT NULL,
  learner_id             uuid NOT NULL,
  session_id             uuid NOT NULL,
  -- Derived by the server from event_id's UUIDv7 timestamp, never taken from
  -- the client. Partition key and part of the PK.
  event_time             timestamptz NOT NULL,
  -- The child's raw clock. Kept for skew analysis; trusted for nothing.
  occurred_at            timestamptz NOT NULL,
  received_at            timestamptz NOT NULL DEFAULT now(),
  client_seq             bigint NOT NULL,
  event_name             text NOT NULL,
  event_version          int NOT NULL,
  lesson_id              uuid,
  item_id                uuid,
  submission_id          uuid,
  path_step_id           uuid,
  verdict_id             uuid,
  payload                jsonb NOT NULL,
  correlation_id         uuid,
  consent_scope_at_write text NOT NULL,
  registry_version       text NOT NULL,
  PRIMARY KEY (learner_id, event_id, event_time),
  CONSTRAINT behavior_event_id_is_uuidv7 CHECK (app.is_uuidv7(event_id)),
  -- The invariant PRO-17 decision on §4.1 rests on. With it, a retry that
  -- restamps its clock still lands in the same partition and collides with the
  -- same PK, so `ON CONFLICT DO NOTHING` is a complete de-duplication rule and
  -- no read-then-write race exists.
  CONSTRAINT behavior_event_time_derived_from_id
    CHECK (event_time = app.uuidv7_timestamp(event_id))
) PARTITION BY RANGE (event_time);

CREATE INDEX behavior_event_learner_time_idx
  ON events.behavior_event (learner_id, event_time DESC);
CREATE INDEX behavior_event_name_time_idx
  ON events.behavior_event (event_name, event_time DESC);
CREATE INDEX behavior_event_correlation_idx
  ON events.behavior_event (correlation_id) WHERE correlation_id IS NOT NULL;
CREATE INDEX behavior_event_session_seq_idx
  ON events.behavior_event (session_id, client_seq);

COMMENT ON TABLE events.behavior_event IS
  'Append-only. A wrong row is corrected by a new row, never by an UPDATE. Retention is DROP PARTITION.';
COMMENT ON COLUMN events.behavior_event.payload IS
  'Never contains text a child typed. Hashes and counts only - the ingest gate refuses the rest.';
COMMENT ON COLUMN events.behavior_event.consent_scope_at_write IS
  'The scope that authorised this write, recorded so consent at the time is provable after the fact.';
COMMENT ON COLUMN events.behavior_event.correlation_id IS
  'Same value as the Langfuse traceId for the AI call this action led to (data-schema §5).';

CREATE TRIGGER behavior_event_append_only
  BEFORE UPDATE OR DELETE ON events.behavior_event
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

-- ---------------------------------------------------------------------------
-- Partition management
-- ---------------------------------------------------------------------------
-- No DEFAULT partition, on purpose: attaching a new partition while a DEFAULT
-- holds rows scans the whole DEFAULT under ACCESS EXCLUSIVE. Anything that
-- would fall outside a partition is rejected at the gate as
-- `implausible_event_time` and dead-lettered instead.
CREATE OR REPLACE FUNCTION events.ensure_month_partition(month_start date)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  from_ts date := date_trunc('month', month_start)::date;
  to_ts   date := (date_trunc('month', month_start) + interval '1 month')::date;
  name    text := format('behavior_event_%s', to_char(from_ts, 'YYYYMM'));
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS events.%I PARTITION OF events.behavior_event FOR VALUES FROM (%L) TO (%L)',
    name, from_ts, to_ts
  );
  RETURN name;
END;
$$;

COMMENT ON FUNCTION events.ensure_month_partition(date) IS
  'Idempotent. Call monthly (and at deploy) to keep at least two months of partitions ahead of now().';

-- Previous, current and the next two months. The previous month is here because
-- the gate accepts an event_time up to 7 days old, which can cross a boundary.
SELECT events.ensure_month_partition((date_trunc('month', now()) - interval '1 month')::date);
SELECT events.ensure_month_partition(date_trunc('month', now())::date);
SELECT events.ensure_month_partition((date_trunc('month', now()) + interval '1 month')::date);
SELECT events.ensure_month_partition((date_trunc('month', now()) + interval '2 month')::date);

-- ---------------------------------------------------------------------------
-- events.event_registry — the Coder/Backend contract, seeded from
-- `src/lib/events/event-registry.v1.json` by `scripts/seed-event-registry.ts`
-- ---------------------------------------------------------------------------
CREATE TABLE events.event_registry (
  event_name             text NOT NULL,
  event_version          int NOT NULL,
  event_group            text NOT NULL,
  trigger_description    text NOT NULL,
  payload_schema         jsonb NOT NULL,
  pii_class              text NOT NULL CHECK (pii_class IN ('none', 'pseudonymous', 'content_hash')),
  retention_days         int NOT NULL,
  exportable             boolean NOT NULL,
  required_consent_scope text NOT NULL DEFAULT 'behaviour_events',
  registry_version       text NOT NULL,
  seeded_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_name, event_version)
);

COMMENT ON TABLE events.event_registry IS
  'Seeded from event-registry.v1.json. The file is the source of truth; this table is how SQL readers see it.';
COMMENT ON COLUMN events.event_registry.payload_schema IS
  'JSON Schema compiled from the registry DSL by src/lib/events/payload-schema.ts - the same schemas POST /api/events validates against.';

-- ---------------------------------------------------------------------------
-- events.dead_letter — nothing is ever dropped silently
-- ---------------------------------------------------------------------------
CREATE TABLE events.dead_letter (
  id               uuid PRIMARY KEY,
  learner_id       uuid,
  session_id       uuid,
  event_id         uuid,
  event_name       text,
  event_version    int,
  registry_version text,
  occurred_at      timestamptz,
  received_at      timestamptz NOT NULL DEFAULT now(),
  reason           text NOT NULL CHECK (reason IN (
                     'malformed_envelope',
                     'unknown_event',
                     'event_version_mismatch',
                     'invalid_event_id',
                     'implausible_event_time',
                     'payload_too_large',
                     'payload_too_deep',
                     'oversized_string',
                     'oversized_collection',
                     'undeclared_payload_key',
                     'payload_type_mismatch')),
  detail           text[] NOT NULL DEFAULT '{}',
  payload_shape    jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX dead_letter_reason_idx ON events.dead_letter (reason, received_at DESC);

COMMENT ON TABLE events.dead_letter IS
  'Quarantine for refused events. Shape-described, never verbatim: the reason an event is here is often that it held text it should not.';
