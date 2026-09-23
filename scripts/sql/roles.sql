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
-- 4b. Objects that already exist — the clause this file originally lacked
-- ---------------------------------------------------------------------------
-- Section 4 was written against an empty database, so default privileges were
-- the whole story. That assumption expired at 09:17 on 2026-09-23, when the
-- PRO-68 migrations were applied as `steamkid_app` after a schema reset that
-- also took back ownership of `identity`/`app`/`events`/`ml`.
--
-- Default privileges only ever apply to objects created *afterwards*, and only
-- by the role named in `FOR ROLE`. So every table that now exists was invisible
-- to them: 31 tables owned by `steamkid_app`, on which `steamkid_runtime` held
-- no privilege of any kind. The roles still existed and `pg_default_acl` still
-- read correctly, which is exactly why this was worth a check rather than a
-- glance — the configuration looked intact while the runtime role could not
-- read a single row.
--
-- These grants are idempotent and additive. Run them as the owner of the
-- objects (`steamkid_app` today, `steamkid_migrate` after the cutover) or as
-- `postgres`.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA identity, app, events
  TO steamkid_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA ml TO steamkid_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA identity, app, events, ml
  TO steamkid_runtime;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA identity, app, events, ml
  TO steamkid_runtime;

-- Bridge, and temporary on purpose. While Backend is still applying migrations
-- as `steamkid_app`, every new migration would otherwise create another table
-- the runtime role cannot touch, and the grants above would need rerunning by
-- hand after each one. Mirroring the section 4 defaults onto `steamkid_app`
-- keeps that from decaying between now and the cutover.
--
-- DELETE THIS BLOCK when `steamkid_app` is dropped; `DROP OWNED BY` removes the
-- entries anyway, and leaving the text here would imply the bridge is permanent.
ALTER DEFAULT PRIVILEGES FOR ROLE steamkid_app IN SCHEMA identity, app, events
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO steamkid_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE steamkid_app IN SCHEMA ml
  GRANT SELECT ON TABLES TO steamkid_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE steamkid_app IN SCHEMA identity, app, events, ml
  GRANT USAGE, SELECT ON SEQUENCES TO steamkid_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE steamkid_app IN SCHEMA identity, app, events, ml
  GRANT EXECUTE ON FUNCTIONS TO steamkid_runtime;

-- Note what these grants deliberately do *not* do: they never make
-- `steamkid_runtime` an owner. `DROP TABLE`, `ALTER TABLE` and `DROP TRIGGER`
-- all require ownership, so the append-only history is still protected while
-- `steamkid_app` holds it. The security invariant survived the reset; only the
-- runtime role's ability to do its job did not.

-- ---------------------------------------------------------------------------
-- 5. Retiring steamkid_app
-- ---------------------------------------------------------------------------
-- The combined DDL+DML role from PRO-70.
--
-- The two REVOKEs below are commented out, and that is a correction rather than
-- an oversight. They were live in the first version of this file, and stripping
-- DDL from a role Backend was actively migrating with turned a permissions
-- decision into what looked like a broken migration. The revoke belongs in the
-- cutover, as one step of an ordered sequence, not standing in a file anyone
-- might re-run while PRO-68 is still in flight.
--
--   REVOKE CREATE ON DATABASE postgres FROM steamkid_app;
--   REVOKE CREATE ON SCHEMA public FROM steamkid_app;
--
-- Cutover, in this order, once both new bindings are live. Run as `postgres`:
-- REASSIGN needs membership in both the source and target roles, which neither
-- steamkid_app nor steamkid_migrate has over the other.
--
--   -- 1. Move the 31 existing objects to the migrator. ACLs travel with the
--   --    object, so section 4b's grants survive this and do not need rerunning.
--   REASSIGN OWNED BY steamkid_app TO steamkid_migrate;
--   -- 2. The four schemas come back under migrator ownership with them, which
--   --    is what restores `steamkid_migrate`'s ability to run migration N+1.
--   --    Verify before continuing:
--   --      select nspname, pg_get_userbyid(nspowner) from pg_namespace
--   --        where nspname in ('identity','app','events','ml');
--   -- 3. Only now take DDL away, and only after Backend has switched to the
--   --    migrate credential. Before this line, steamkid_app still works.
--   REVOKE CREATE ON DATABASE postgres FROM steamkid_app;
--   REVOKE CREATE ON SCHEMA public FROM steamkid_app;
--   -- 4. Drops the section 4b bridge defaults along with anything else left.
--   DROP OWNED BY steamkid_app;
--   DROP ROLE steamkid_app;
--
-- `npm run verify:grants` after step 2 and `npm run verify:roles` after step 4.
-- Do not drop the role before the bindings are gone: a dropped role turns a
-- readable `42501` into an authentication failure against a name that no longer
-- exists, which is far harder to diagnose.

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
