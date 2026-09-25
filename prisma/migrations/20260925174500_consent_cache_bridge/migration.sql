-- PRO-174: bridge app.consent_current to also read from app.learner_consent_cache.
--
-- POST /api/consent writes to app.learner_consent_cache (the pre-auth bridge
-- introduced in PRO-169). The authoritative app.consent_record requires a
-- guardian_user_id FK that does not exist in the current pre-auth flow. Because
-- app.consent_current only queried app.consent_record, app.has_consent() returned
-- false for every learner, so every AI verdict INSERT and every behaviour event
-- was silently refused.
--
-- Fix: union app.learner_consent_cache into app.consent_current. Ledger rows
-- take strict precedence (src=1 over src=2) so that when guardian auth arrives
-- and writes real consent_record rows, those automatically supersede the cache
-- without any code change.
--
-- Also adds a trigger so app.learner.consent_state stays in sync when the cache
-- changes, mirroring the trigger on consent_record that already exists.
--
-- REVERSIBLE: down.sql restores the original view and removes the trigger.

CREATE OR REPLACE VIEW app.consent_current AS
SELECT DISTINCT ON (learner_id, scope)
       learner_id, scope, granted, policy_version, effective_at
FROM (
  -- Authoritative append-only ledger (priority 1).
  SELECT id, learner_id, scope, granted, policy_version, effective_at, 1 AS src
  FROM app.consent_record

  UNION ALL

  -- Pre-auth cache: expand the scopes array to one row per scope (priority 2).
  SELECT NULL::uuid AS id, c.learner_id, s.scope, true AS granted,
         c.policy_version, c.granted_at AS effective_at, 2 AS src
  FROM app.learner_consent_cache c,
       unnest(c.scopes) AS s(scope)
) combined
ORDER BY learner_id, scope, src ASC, effective_at DESC, id DESC NULLS LAST;

COMMENT ON VIEW app.consent_current IS
  'Current consent per (learner, scope). Reads app.consent_record (authoritative) '
  'with app.learner_consent_cache as fallback for the pre-guardian-auth flow. '
  'The only sanctioned read path — never interpret raw rows directly.';

-- Keep app.learner.consent_state in sync when the cache changes.
-- The existing trigger on app.consent_record only fires on ledger inserts;
-- this covers the pre-auth path where writes go to the cache only.
CREATE OR REPLACE FUNCTION app.refresh_consent_state_from_cache()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_id uuid;
BEGIN
  target_id := CASE TG_OP WHEN 'DELETE' THEN OLD.learner_id ELSE NEW.learner_id END;
  UPDATE app.learner
  SET consent_state = coalesce((
        SELECT string_agg(c.scope, ',' ORDER BY c.scope)
        FROM app.consent_current c
        WHERE c.learner_id = target_id AND c.granted
      ), '')
  WHERE id = target_id;
  RETURN NULL;
END;
$$;

CREATE TRIGGER consent_cache_refresh_state
  AFTER INSERT OR UPDATE OR DELETE ON app.learner_consent_cache
  FOR EACH ROW EXECUTE FUNCTION app.refresh_consent_state_from_cache();
