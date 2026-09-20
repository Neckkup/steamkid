-- Migration 1 of 3 for PRO-7: the four schemas, identity, and consent.
--
-- Source of truth: PRO-3 `data-schema` v1.1.0 §1–§3.1, with the PRO-17
-- decisions (SQL-first DDL, uuidv7 primary keys, append-only consent).
--
-- REVERSIBLE: `down.sql` in this directory drops the four schemas. It is safe
-- only while they hold no production rows; after the first real learner it
-- becomes a data-destroying operation and must not be run.
--
-- Why SQL and not Prisma Migrate: `CREATE SCHEMA`, `citext`, cross-schema
-- foreign keys, `CHECK`, views and (migration 2) `PARTITION BY RANGE` are all
-- load-bearing here and Prisma's schema language cannot express them.
-- `schema.prisma` is re-synced from the database with `prisma db pull`.

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- §0 decision 1: four schemas, so "the training export is everything except
-- `identity`" is a rule you can check by looking, not a 200-column audit.
CREATE SCHEMA IF NOT EXISTS identity;
CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS events;
CREATE SCHEMA IF NOT EXISTS ml;

COMMENT ON SCHEMA identity IS
  'PII lives here and only here. Never joined into an ml view, an export, or an external trace.';
COMMENT ON SCHEMA app IS 'Product data keyed by the pseudonymous app.learner.id.';
COMMENT ON SCHEMA events IS 'The append-only behaviour pipe.';
COMMENT ON SCHEMA ml IS 'Consent-filtered, identity-free views for training exports.';

-- ---------------------------------------------------------------------------
-- uuidv7 helpers
-- ---------------------------------------------------------------------------
-- Postgres 17 has no native `uuidv7()` (it lands in 18) and `gen_random_uuid()`
-- is v4, which scatters inserts across every index page of a time-ordered,
-- append-only table. Application code mints ids with `src/lib/ids.ts`; these
-- functions exist so migrations, seeds and *the database's own constraints* can
-- speak the same format. `src/lib/events/uuidv7.test.ts` pins the two
-- implementations to the same bytes.

CREATE OR REPLACE FUNCTION app.uuidv7(at timestamptz DEFAULT clock_timestamp())
RETURNS uuid
LANGUAGE sql
VOLATILE
AS $$
  SELECT encode(
    set_bit(
      set_bit(
        overlay(
          uuid_send(gen_random_uuid())
          PLACING substring(int8send((extract(epoch FROM at) * 1000)::bigint) FROM 3)
          FROM 1 FOR 6
        ),
        52, 1
      ),
      53, 1
    ),
    'hex'
  )::uuid;
$$;

COMMENT ON FUNCTION app.uuidv7(timestamptz) IS
  'RFC 9562 UUIDv7. For migrations, seeds and fixtures. Request-path ids are minted by src/lib/ids.ts.';

-- IMMUTABLE on purpose: it is used inside a CHECK constraint (migration 2) so
-- that `behavior_event.event_time = f(event_id)` is enforced by the database
-- rather than promised by the ingest code.
CREATE OR REPLACE FUNCTION app.uuidv7_timestamp(id uuid)
RETURNS timestamptz
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT to_timestamp(
    (('x' || lpad(substring(replace(id::text, '-', '') FROM 1 FOR 12), 16, '0'))::bit(64)::bigint)
    / 1000.0
  );
$$;

CREATE OR REPLACE FUNCTION app.is_uuidv7(id uuid)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT substring(replace(id::text, '-', '') FROM 13 FOR 1) = '7';
$$;

-- ---------------------------------------------------------------------------
-- Append-only guard, shared by every table the schema-evolution rules (§7)
-- name as append-only.
-- ---------------------------------------------------------------------------
-- An escape hatch exists because two lawful operations really do delete rows:
-- retention enforcement and a guardian's erasure request. Both are jobs that
-- must leave an audit trail, so both have to say so out loud:
--   SET LOCAL steamkid.allow_erasure = 'on';
-- A stray UPDATE in a request handler cannot do that by accident.
CREATE OR REPLACE FUNCTION app.reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF coalesce(current_setting('steamkid.allow_erasure', true), 'off') = 'on'
     AND TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION
    '%.% is append-only: % is not allowed. Write a correcting row instead.',
    TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

-- ---------------------------------------------------------------------------
-- app.learner — the pseudonymous spine every other table hangs off
-- ---------------------------------------------------------------------------
CREATE TABLE app.learner (
  id            uuid PRIMARY KEY,
  public_ref    uuid NOT NULL UNIQUE,
  grade_band    text NOT NULL CHECK (grade_band IN ('p4', 'p5', 'p6')),
  locale        text NOT NULL DEFAULT 'th-TH',
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  -- Cache of app.consent_current, maintained by trigger, so the hot ingest path
  -- reads one column instead of a per-event join. Authority is the view.
  consent_state text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  CONSTRAINT learner_id_is_uuidv7 CHECK (app.is_uuidv7(id)),
  CONSTRAINT learner_public_ref_is_uuidv7 CHECK (app.is_uuidv7(public_ref))
);

COMMENT ON COLUMN app.learner.id IS
  'Internal only. Never leaves our infrastructure — not to Langfuse, not to Sentry, not into an export.';
COMMENT ON COLUMN app.learner.public_ref IS
  'The only learner identifier allowed outside: Langfuse userId, Sentry user.id, training-set key. Rotatable without touching a single foreign key.';
COMMENT ON COLUMN app.learner.consent_state IS
  'Denormalised cache: comma-separated sorted list of currently granted scopes. Derived from app.consent_current by trigger; never write it by hand.';

-- ---------------------------------------------------------------------------
-- identity — PII, and nothing else
-- ---------------------------------------------------------------------------
CREATE TABLE identity.user_account (
  id                uuid PRIMARY KEY,
  role              text NOT NULL CHECK (role IN ('guardian', 'teacher', 'admin')),
  email             citext NOT NULL UNIQUE,
  auth_provider     text NOT NULL,
  auth_subject_id   text NOT NULL,
  display_name      text,
  email_verified_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  UNIQUE (auth_provider, auth_subject_id),
  CONSTRAINT user_account_id_is_uuidv7 CHECK (app.is_uuidv7(id))
);

COMMENT ON TABLE identity.user_account IS
  'Adults only — guardians, teachers, admins. Children never hold an account.';
COMMENT ON COLUMN identity.user_account.auth_subject_id IS
  'Subject id from the auth provider. We never store a password or a hash of one.';

CREATE TABLE identity.learner_profile (
  learner_id       uuid PRIMARY KEY REFERENCES app.learner(id) ON DELETE CASCADE,
  display_name     text NOT NULL,
  birth_year_month date NOT NULL,
  avatar_key       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- Year-month only. Storing the day buys nothing a grade band does not and
  -- turns a nickname plus a birthday into an identifying pair.
  CONSTRAINT learner_profile_birth_is_month_start CHECK (extract(day FROM birth_year_month) = 1)
);

COMMENT ON TABLE identity.learner_profile IS
  'Never exported, under any flag, for any purpose.';
COMMENT ON COLUMN identity.learner_profile.display_name IS
  'Nickname. The UI must refuse a full legal name.';

CREATE TABLE identity.pii_access_log (
  id            uuid PRIMARY KEY,
  actor_user_id uuid REFERENCES identity.user_account(id),
  actor_kind    text NOT NULL CHECK (actor_kind IN ('user', 'agent', 'job')),
  learner_id    uuid NOT NULL,
  purpose       text NOT NULL,
  accessed_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pii_access_log_learner_idx ON identity.pii_access_log (learner_id, accessed_at DESC);

CREATE TRIGGER pii_access_log_append_only
  BEFORE UPDATE OR DELETE ON identity.pii_access_log
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

-- ---------------------------------------------------------------------------
-- app.guardian_link
-- ---------------------------------------------------------------------------
CREATE TABLE app.guardian_link (
  guardian_user_id uuid NOT NULL REFERENCES identity.user_account(id),
  learner_id       uuid NOT NULL REFERENCES app.learner(id),
  relationship     text NOT NULL,
  verified_at      timestamptz,
  PRIMARY KEY (guardian_user_id, learner_id)
);
CREATE INDEX guardian_link_learner_idx ON app.guardian_link (learner_id);

-- ---------------------------------------------------------------------------
-- app.consent_record — append-only (§3.1, PRO-17 decision 2)
-- ---------------------------------------------------------------------------
-- Withdrawal is a new row with `granted = false`, never an UPDATE of the old
-- one. Otherwise we can never prove, after the fact, that consent was actually
-- in force at the moment an event was written — which is the entire question a
-- regulator or a parent would ask.
CREATE TABLE app.consent_record (
  id               uuid PRIMARY KEY,
  learner_id       uuid NOT NULL REFERENCES app.learner(id),
  guardian_user_id uuid NOT NULL REFERENCES identity.user_account(id),
  policy_version   text NOT NULL,
  scope            text NOT NULL CHECK (scope IN (
                     'service_operation',
                     'ai_grading',
                     'behaviour_events',
                     'external_monitoring',
                     'training_use')),
  granted          boolean NOT NULL,
  method           text NOT NULL,
  evidence         jsonb NOT NULL,
  effective_at     timestamptz NOT NULL DEFAULT now(),
  superseded_by    uuid REFERENCES app.consent_record(id),
  CONSTRAINT consent_record_id_is_uuidv7 CHECK (app.is_uuidv7(id)),
  CONSTRAINT consent_record_not_self_superseding CHECK (superseded_by IS DISTINCT FROM id),
  -- {ip_hash, ua_hash, ui_version}: hashes, never a raw IP or user agent.
  CONSTRAINT consent_record_evidence_has_no_raw_ip CHECK (
    NOT (evidence ? 'ip') AND NOT (evidence ? 'ip_address') AND NOT (evidence ? 'user_agent')
  )
);
CREATE INDEX consent_record_lookup_idx
  ON app.consent_record (learner_id, scope, effective_at DESC);

CREATE OR REPLACE FUNCTION app.consent_record_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'app.consent_record is append-only: withdraw consent by inserting a row with granted = false.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF ROW(NEW.id, NEW.learner_id, NEW.guardian_user_id, NEW.policy_version, NEW.scope,
         NEW.granted, NEW.method, NEW.evidence, NEW.effective_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.learner_id, OLD.guardian_user_id, OLD.policy_version, OLD.scope,
         OLD.granted, OLD.method, OLD.evidence, OLD.effective_at) THEN
    RAISE EXCEPTION
      'app.consent_record is append-only: superseded_by is the only updatable column.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.superseded_by IS NOT NULL THEN
    RAISE EXCEPTION
      'app.consent_record.superseded_by is write-once and is already set on %.', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.superseded_by IS NULL THEN
    RAISE EXCEPTION
      'app.consent_record.superseded_by cannot be cleared.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER consent_record_append_only
  BEFORE UPDATE OR DELETE ON app.consent_record
  FOR EACH ROW EXECUTE FUNCTION app.consent_record_guard();

-- The only sanctioned way to read consent. Reading raw rows and picking a
-- winner yourself is how two call sites end up disagreeing about whether a
-- child is opted in.
CREATE VIEW app.consent_current AS
SELECT DISTINCT ON (learner_id, scope)
       learner_id, scope, granted, policy_version, effective_at
FROM app.consent_record
ORDER BY learner_id, scope, effective_at DESC, id DESC;

COMMENT ON VIEW app.consent_current IS
  'Current consent per (learner, scope). The only sanctioned read path — never interpret raw consent_record rows.';

-- Keep app.learner.consent_state in step with the view above.
CREATE OR REPLACE FUNCTION app.refresh_consent_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE app.learner l
  SET consent_state = coalesce((
        SELECT string_agg(c.scope, ',' ORDER BY c.scope)
        FROM app.consent_current c
        WHERE c.learner_id = l.id AND c.granted
      ), '')
  WHERE l.id = NEW.learner_id;
  RETURN NULL;
END;
$$;

CREATE TRIGGER consent_record_refresh_state
  AFTER INSERT ON app.consent_record
  FOR EACH ROW EXECUTE FUNCTION app.refresh_consent_state();

-- Convenience predicate for the ingest path and for every read that must honour
-- consent. One definition, so "does this child have consent" cannot be answered
-- two different ways in two different files.
CREATE OR REPLACE FUNCTION app.has_consent(p_learner_id uuid, p_scope text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM app.consent_current c
    WHERE c.learner_id = p_learner_id AND c.scope = p_scope AND c.granted
  );
$$;
