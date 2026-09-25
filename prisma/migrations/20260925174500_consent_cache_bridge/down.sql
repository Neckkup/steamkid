-- Restore consent_current to ledger-only and remove the cache trigger.
DROP TRIGGER IF EXISTS consent_cache_refresh_state ON app.learner_consent_cache;
DROP FUNCTION IF EXISTS app.refresh_consent_state_from_cache();

CREATE OR REPLACE VIEW app.consent_current AS
SELECT DISTINCT ON (learner_id, scope)
       learner_id, scope, granted, policy_version, effective_at
FROM app.consent_record
ORDER BY learner_id, scope, effective_at DESC, id DESC;

COMMENT ON VIEW app.consent_current IS
  'Current consent per (learner, scope). The only sanctioned read path — never interpret raw consent_record rows.';
