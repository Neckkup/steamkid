-- The two database roles, and why each grant is the size it is (PRO-103).
--
-- Run as the project's `postgres` role. Idempotent: re-running it is a no-op.
-- `npm run verify:roles` is the check that this file actually did what it says.
--
-- NO PASSWORDS LIVE HERE. The two roles are created with a pre-computed
-- SCRAM-SHA-256 verifier so the plaintext never enters a file, a transcript, or
-- a review. Passwords are minted once and go straight to the Paperclip vault as
-- `steamkid/postgres/migrate-url` and `steamkid/postgres/runtime-url`. To rotate,
-- generate a new password, derive a verifier, and `ALTER ROLE ... PASSWORD
-- '<verifier>'` — see "Rotating a password" at the bottom.
--
-- ---------------------------------------------------------------------------
-- The split, in one sentence
-- ---------------------------------------------------------------------------
-- `steamkid_migrate` owns and reshapes the schema; `steamkid_runtime` reads and
-- writes rows and can do nothing else. The application only ever holds the
-- second one, so a bug or an injection in app code cannot drop a table or
-- remove the append-only triggers that protect a child's history.

-- ---------------------------------------------------------------------------
-- 1. The roles
-- ---------------------------------------------------------------------------
-- Neither role may create other roles or databases. Replace the verifier
-- strings when provisioning a new environment; the ones a live environment uses
-- are never committed.
--
--   CREATE ROLE steamkid_migrate LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
--     PASSWORD 'SCRAM-SHA-256$4096:<salt>$<StoredKey>:<ServerKey>';
--   CREATE ROLE steamkid_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
--     PASSWORD 'SCRAM-SHA-256$4096:<salt>$<StoredKey>:<ServerKey>';

-- Supabase grants role membership with SET FALSE. `postgres` already holds
-- ADMIN on both roles, so this adds no authority it did not have — it only
-- makes SET ROLE usable, which `AUTHORIZATION` and `ALTER DEFAULT PRIVILEGES
-- FOR ROLE` both require.
GRANT steamkid_migrate TO postgres WITH SET TRUE;
GRANT steamkid_runtime TO postgres WITH SET TRUE;

-- ---------------------------------------------------------------------------
-- 2. Database level
-- ---------------------------------------------------------------------------
-- `CREATE` on the database is what lets migration 1 run `CREATE SCHEMA`. The
-- runtime role must never hold it: with it, "no DDL" is decoration, because the
-- role could simply build itself a schema it owns and do as it likes there.
GRANT CONNECT, CREATE ON DATABASE postgres TO steamkid_migrate;
GRANT CONNECT ON DATABASE postgres TO steamkid_runtime;
REVOKE CREATE ON DATABASE postgres FROM steamkid_runtime;

-- ---------------------------------------------------------------------------
-- 3. The four schemas, created up front
-- ---------------------------------------------------------------------------
-- These normally appear in migration 1. They are created here instead, owned by
-- the migrator, for one reason: `ALTER DEFAULT PRIVILEGES ... IN SCHEMA`
-- requires the schema to already exist, and default privileges only apply to
-- objects created *after* they are set. Setting them after the first migration
-- would leave every table from that migration without runtime grants, and the
-- hand-written `GRANT`s used to paper over that would then have to be repeated,
-- correctly, by every future migration. Migration 1's
-- `CREATE SCHEMA IF NOT EXISTS` short-circuits, and its `COMMENT ON SCHEMA`
-- still works because the migrator owns them.
CREATE SCHEMA IF NOT EXISTS identity AUTHORIZATION steamkid_migrate;
CREATE SCHEMA IF NOT EXISTS app      AUTHORIZATION steamkid_migrate;
CREATE SCHEMA IF NOT EXISTS events   AUTHORIZATION steamkid_migrate;
CREATE SCHEMA IF NOT EXISTS ml       AUTHORIZATION steamkid_migrate;

-- Prisma keeps `_prisma_migrations` in `public`, so the migrator needs CREATE
-- there too. `citext` also lives in `public` — see ADR 0005 for why.
GRANT USAGE, CREATE ON SCHEMA public TO steamkid_migrate;

-- The runtime role may look into the schemas and never create in them.
GRANT USAGE ON SCHEMA identity, app, events, ml, public TO steamkid_runtime;
REVOKE CREATE ON SCHEMA identity, app, events, ml, public FROM steamkid_runtime;

-- ---------------------------------------------------------------------------
-- 4. Default privileges — the part that has to exist before migration 1
-- ---------------------------------------------------------------------------
-- Every table a future migration creates hands the runtime role DML
-- automatically. Without this, someone has to remember a `GRANT` in every
-- migration forever, and the failure mode when they forget is a production
-- permission error, not a test failure.
ALTER DEFAULT PRIVILEGES FOR ROLE steamkid_migrate IN SCHEMA identity, app, events, ml
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO steamkid_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE steamkid_migrate IN SCHEMA identity, app, events, ml
  GRANT USAGE, SELECT ON SEQUENCES TO steamkid_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE steamkid_migrate IN SCHEMA identity, app, events, ml
  GRANT EXECUTE ON FUNCTIONS TO steamkid_runtime;

-- `ml` is the consent-filtered projection the training export reads. It has no
-- legitimate write path from application code, so it does not get one.
ALTER DEFAULT PRIVILEGES FOR ROLE steamkid_migrate IN SCHEMA ml
  REVOKE INSERT, UPDATE, DELETE ON TABLES FROM steamkid_runtime;

-- ---------------------------------------------------------------------------
-- 5. Retiring steamkid_app
-- ---------------------------------------------------------------------------
-- The combined DDL+DML role from PRO-70. It is stripped of DDL here rather than
-- dropped, so that the switch to the new credentials stays reversible while the
-- new secret bindings are still being approved. Drop it once both new bindings
-- are live and `npm run verify:roles` passes from a binding-injected
-- environment:
--
--   REASSIGN OWNED BY steamkid_app TO steamkid_migrate;  -- expected: owns nothing
--   DROP OWNED BY steamkid_app;
--   DROP ROLE steamkid_app;
REVOKE CREATE ON DATABASE postgres FROM steamkid_app;
REVOKE CREATE ON SCHEMA public FROM steamkid_app;

-- ---------------------------------------------------------------------------
-- What this should look like afterwards
-- ---------------------------------------------------------------------------
-- Database ACL: steamkid_migrate=Cc, steamkid_runtime=c, steamkid_app=c
-- Schema ACL  : steamkid_migrate=UC, steamkid_runtime=U
--
--   select datacl::text from pg_database where datname = current_database();
--   select nspname, pg_get_userbyid(nspowner), nspacl::text from pg_namespace
--     where nspname in ('identity','app','events','ml','public');
--   select n.nspname, d.defaclobjtype, d.defaclacl::text
--     from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace
--     where pg_get_userbyid(d.defaclrole) = 'steamkid_migrate';
--
-- ---------------------------------------------------------------------------
-- Rotating a password
-- ---------------------------------------------------------------------------
-- Postgres accepts a SCRAM verifier wherever it accepts a password, which keeps
-- the plaintext out of SQL, logs, and `pg_stat_statements`:
--
--   node -e '
--     const c = require("node:crypto");
--     const password = c.randomBytes(24).toString("base64url");
--     const salt = c.randomBytes(16), iter = 4096;
--     const salted = c.pbkdf2Sync(password, salt, iter, 32, "sha256");
--     const stored = c.createHash("sha256")
--       .update(c.createHmac("sha256", salted).update("Client Key").digest()).digest();
--     const server = c.createHmac("sha256", salted).update("Server Key").digest();
--     console.log(`SCRAM-SHA-256$${iter}:${salt.toString("base64")}$` +
--       `${stored.toString("base64")}:${server.toString("base64")}`);
--     // `password` goes to the Paperclip vault, never to a file or a comment.
--   '
--
-- Then `ALTER ROLE <role> PASSWORD '<verifier>';` and raise a secret proposal
-- with the new URL. Existing pooled connections survive until they recycle.
