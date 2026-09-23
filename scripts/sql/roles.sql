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

-- Supabase grants `postgres` membership in both roles with ADMIN TRUE but
-- INHERIT FALSE, SET FALSE, and since PostgreSQL 16 those are three separate
-- things. ADMIN lets `postgres` grant the role away; it does *not* give it the
-- privileges of the role, which is what `SET ROLE`, `AUTHORIZATION` and `ALTER
-- DEFAULT PRIVILEGES FOR ROLE` all need. So this does add authority, and saying
-- otherwise cost us a cutover attempt: `REASSIGN OWNED BY steamkid_app` failed
-- with "Only roles with privileges of role steamkid_app may reassign objects
-- owned by it" even though `postgres` held ADMIN on it (measured 2026-09-23).
-- The membership a REASSIGN needs is the one below, not the one Supabase ships.
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
-- These grants are idempotent and additive. Run them **as the owner of the
-- objects** — `steamkid_migrate`, which has owned all of them since the
-- cutover on 2026-09-23. (It was `steamkid_app` while this was written.)
--
-- Not as `postgres`, and this is a trap worth knowing: `GRANT`/`REVOKE` only
-- affect privileges the *issuing role* itself granted. `steamkid_app` is the
-- grantor of record for everything below, so the same statements run as
-- `postgres` match nothing, change nothing, and raise only a warning rather
-- than an error. Measured 2026-09-23: `REVOKE DELETE ON app.ai_verdict FROM
-- steamkid_runtime` as `postgres` returned cleanly and the privilege was still
-- there afterwards. A privilege script that appears to succeed while doing
-- nothing is the worst possible failure mode for this file — always re-read the
-- catalog, or run `npm run verify:grants`, rather than trusting the exit code.
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
-- 4c. The migrator's own CREATE — the other half of the 09:17 damage
-- ---------------------------------------------------------------------------
-- Section 4b restored what the *runtime* role lost in the reset and stopped
-- there, which left the migrator broken in a way nothing looked at.
--
-- Section 3 grants the migrator CREATE only implicitly, by making it the owner
-- of the four schemas. Once they exist, `CREATE SCHEMA IF NOT EXISTS ...
-- AUTHORIZATION` is a no-op: it does not transfer ownership, so re-running this
-- file cannot repair that. After the reset handed the schemas to `steamkid_app`,
-- `steamkid_migrate` held `CREATE` on the *database* but on none of the four
-- schemas, and a `SET ROLE` probe confirmed it:
--
--   CREATE TABLE app.__probe AS steamkid_migrate -> 42501 permission denied
--                                                   for schema app  (all four)
--
-- That is the first statement of the next `prisma migrate deploy`. The cutover
-- plan hands Backend the migrator credential (step 2) before it reassigns
-- ownership (step 3), so the window between them would have been a migrator
-- that cannot migrate — reported as "permission denied for schema app", which
-- reads like a broken migration rather than a missing grant. We have already
-- spent one outage on that exact ambiguity today.
--
-- Granting it explicitly closes the window and is correct in both directions:
-- before the cutover it is the only thing giving the migrator DDL, and after
-- `REASSIGN OWNED` it is redundant with ownership but harmless. Issue this as
-- the schema owner (`steamkid_migrate` since the cutover; `steamkid_app` before
-- it), for the grantor reason in 4b above — as `postgres` these are silent
-- no-ops, not errors.
GRANT USAGE, CREATE ON SCHEMA identity, app, events, ml TO steamkid_migrate;

-- Prisma's ledger, and the same trap one layer down. `public._prisma_migrations`
-- is owned by `steamkid_app`, and the migrator held nothing on it at all — not
-- even SELECT. Prisma touches this table before it touches anything else, so
-- the failure would not have waited for a migration: `prisma migrate status`,
-- which the cutover uses as its proof that the new credential works, would have
-- been the thing that broke.
--
-- `REASSIGN OWNED` in cutover step 3 does hand this over, but step 2 switches
-- Backend's credential first. Granting it now means the migrator credential is
-- complete the moment it is bound, whenever that happens.
--
-- `steamkid_runtime` is deliberately not given access: application code has no
-- business reading or rewriting migration history.
GRANT SELECT, INSERT, UPDATE, DELETE ON public._prisma_migrations TO steamkid_migrate;

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
-- steamkid_app nor steamkid_migrate has over the other. `postgres` does — but
-- not in the form the earlier version of this comment claimed. It said the
-- ADMIN membership Supabase grants was "the whole reason the sequence below is
-- runnable", and ADMIN is precisely the column that does not help:
--
--   REASSIGN OWNED BY steamkid_app TO steamkid_migrate;
--   ERROR: 42501 permission denied to reassign objects
--   DETAIL: Only roles with privileges of role "steamkid_app" may reassign
--           objects owned by it.
--
-- Check all three columns, not just admin_option — this is the query, and the
-- row that matters is one with inherit_option or set_option true:
--
--   select r.rolname as granted, m.rolname as member,
--          am.admin_option, am.inherit_option, am.set_option,
--          g.rolname as grantor
--     from pg_auth_members am
--     join pg_roles r on r.oid = am.roleid
--     join pg_roles m on m.oid = am.member
--     join pg_roles g on g.oid = am.grantor
--    where r.rolname like 'steamkid%';
--
-- Section 1 already grants that membership for the two new roles. The retiring
-- role never got it, so the cutover has a step 0.5 that the plan did not:
--
--   GRANT steamkid_app TO postgres WITH INHERIT TRUE, SET TRUE;
--
-- ADMIN on steamkid_app is what makes that grant legal, and it disappears with
-- the role at the end of the sequence. `postgres` is not a superuser on
-- Supabase (only supabase_admin is), so without this line the sequence below is
-- not runnable at all.
--
-- Section 4c changes what this sequence has to guarantee. The approved plan had
-- Backend switch credentials (its step 2) before REASSIGN (its step 3), which
-- left a window where the migrator credential was bound but could neither create
-- a table nor read Prisma's ledger. With 4c applied that window is gone: the
-- migrator works the moment it is bound, and REASSIGN below is now only about
-- ownership — ALTER/DROP on the 31 existing tables, and retiring steamkid_app.
-- The order is still the order; it is no longer load-bearing for Backend.
--
-- Steps 1–3 ran on 2026-09-23 at 11:0x, after all four bindings executed.
-- `verify:grants` read 43/43 immediately before and immediately after, which is
-- the evidence that ACLs travel with the object: every grant section 4b made
-- had `steamkid_app` as its grantor, and `ALTER ... OWNER` rewrote those
-- entries to `steamkid_migrate` rather than dropping them. Step 4 is still
-- outstanding and is gated on step 0 below.
--
--   -- 1. Move the 128 existing objects to the migrator (31 tables plus their
--   --    indexes, 9 views, the four schemas, 10 functions, 80 types and
--   --    Prisma's ledger). ACLs travel with the object, so section 4b's grants
--   --    survive this and do not need rerunning.
--   REASSIGN OWNED BY steamkid_app TO steamkid_migrate;
--   -- 2. The four schemas come back under migrator ownership with them, which
--   --    is what restores `steamkid_migrate`'s ability to run migration N+1.
--   --    Verify before continuing:
--   --      select nspname, pg_get_userbyid(nspowner) from pg_namespace
--   --        where nspname in ('identity','app','events','ml');
--   -- 3. Only now take DDL away, and only after Backend has switched to the
--   --    migrate credential. Before this line, steamkid_app still works.
--   --    These two are REVOKEs, so the grantor rule in 4b applies: they only
--   --    remove what the issuing role granted, and they warn rather than error
--   --    when they match nothing. Confirm afterwards instead of assuming:
--   --      select has_database_privilege('steamkid_app', current_database(), 'CREATE'),
--   --             has_schema_privilege('steamkid_app', 'public', 'CREATE');
--   --    Both must read false. If either is still true, re-issue the REVOKE as
--   --    whichever role granted it (see the `/grantor` suffix in the ACL).
--   REVOKE CREATE ON DATABASE postgres FROM steamkid_app;
--   REVOKE CREATE ON SCHEMA public FROM steamkid_app;
--   -- 4. Drops the section 4b bridge defaults (12 pg_default_acl entries that
--   --    are already inert, since after step 3 steamkid_app cannot create
--   --    anything for them to apply to) and revokes CONNECT along with them.
--   DROP OWNED BY steamkid_app;
--   DROP ROLE steamkid_app;
--
-- `npm run verify:grants` after step 2 and `npm run verify:roles` after step 4.
--
-- Between step 3 and step 4, `steamkid_app` is inert rather than gone: it can
-- still authenticate, and holds CONNECT and nothing else — no privilege on any
-- schema, table, view or sequence, measured. That is the intended resting place
-- while the old bindings survive, because it is the state that produces the
-- most readable error for anyone still reaching for `DATABASE_URL` by habit.
--
-- Step 0, and it is not SQL: the founder must delete the `env.DATABASE_URL` and
-- `env.DIRECT_URL` bindings from **Backend** and **CTO** before step 4 runs.
--
-- The plan used to say these two would simply be overwritten by binding the new
-- credentials under the same names. They cannot be: Paperclip refuses to write a
-- config path that already holds a secret_ref (`http_409`, measured on four
-- accepted cards), and no agent-facing route removes a binding. The split roles
-- are therefore injected as `MIGRATE_DATABASE_URL` / `RUNTIME_DATABASE_URL`
-- instead, and the two old variables keep pointing at steamkid_app until a human
-- removes them.
--
-- Application code is safe either way — the new names win in
-- `src/lib/db/connection-env.ts`, so a leftover injection is ignored rather than
-- obeyed. The hazard is a person or a tool that reaches for `DATABASE_URL` by
-- habit: after the DROP, that value authenticates as a role that no longer
-- exists, turning a readable `42501` into an authentication failure against a
-- name nobody can find. Removing the bindings first keeps the error honest.

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
