/**
 * Active learner resolution for the current request (PRO-197).
 *
 * The `sk_learner` cookie now carries meaning only when:
 *   1. The request has an authenticated session, AND
 *   2. `app.guardian_link` records that the session user owns that learner.
 *
 * On the first authenticated request in a browser that holds an `sk_learner`
 * cookie for a learner with zero `guardian_link` rows, the learner is claimed:
 * a `guardian_link` is inserted and any cached consent from the pre-auth period
 * is copied to `app.consent_record` with `method='claimed_on_signin'`. If the
 * learner is already linked to a different parent, the cookie is cleared.
 *
 * In non-production environments without a DB session, the old cookie-only
 * behaviour is preserved for local development.
 *
 * Callers that held `ensureLearnerRef()` for anonymous minting no longer need
 * to create a learner — `POST /api/children` now does that. In production,
 * `ensureLearnerRef()` returns the cookie value only when a valid owned link
 * already exists; it never mints a new UUID anonymously.
 */

import { cookies } from "next/headers";

import { auth } from "@/auth";
import { getBehaviourDb } from "@/lib/events/runtime";
import { isUuidV7, uuidv7 } from "@/lib/ids";
import { CONSENT_POLICY_VERSION } from "@/lib/learning/consent";
import { env } from "@/lib/env";

import { getLearningStore, type ConsentState } from "./store";

export const LEARNER_COOKIE = "sk_learner";

const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 180;

/**
 * Attempt to claim a cookie-only learner (zero guardian_link rows) for the
 * signed-in parent. Inserts the link and migrates any cached consent scopes.
 *
 * Returns `true` when the claim succeeded, `false` when the learner does not
 * exist in the DB (pre-auth learner with no row yet).
 */
async function claimLearnerCookie(
  learnerRef: string,
  userId: string,
): Promise<boolean> {
  const db = getBehaviourDb();
  if (!db) return false;

  const { rows: learnerRows } = await db.query<{ id: string }>(
    `SELECT id FROM app.learner WHERE public_ref = $1::uuid`,
    [learnerRef],
  );
  const learnerId = learnerRows[0]?.id;
  if (!learnerId) return false;

  await db.query(
    `INSERT INTO app.guardian_link (guardian_user_id, learner_id, relationship, verified_at)
     VALUES ($1::uuid, $2::uuid, 'parent', now())
     ON CONFLICT (guardian_user_id, learner_id) DO NOTHING`,
    [userId, learnerId],
  );

  // Migrate cached consent scopes from app.learner_consent_cache (pre-auth) to
  // app.consent_record (authoritative ledger) so the signed-in parent becomes
  // the recorded guardian for all existing consent.
  const { rows: cacheRows } = await db.query<{
    scopes: string[];
    policy_version: string;
  }>(
    `SELECT scopes, policy_version FROM app.learner_consent_cache
     WHERE learner_id = $1::uuid`,
    [learnerId],
  );

  if (cacheRows[0]?.scopes?.length) {
    const cache = cacheRows[0];
    const policyVersion = cache.policy_version || CONSENT_POLICY_VERSION;
    const evidence = JSON.stringify({ migrated_from: "learner_consent_cache" });

    for (const scope of cache.scopes) {
      await db.query(
        `INSERT INTO app.consent_record
           (id, learner_id, guardian_user_id, policy_version, scope, granted, method, evidence)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, true, 'claimed_on_signin', $6::jsonb)`,
        [uuidv7(), learnerId, userId, policyVersion, scope, evidence],
      );
    }
  }

  return true;
}

/**
 * The learner for this request.
 *
 * In production (or whenever a DB session and authenticated session are both
 * available): returns the cookie value only when a `guardian_link` connects the
 * signed-in user to that learner. Also performs the one-time cookie claim for
 * pre-auth learners.
 *
 * In local development without DB or without a session: falls back to the
 * cookie value as before, so local testing remains possible without auth.
 */
export async function getLearnerRef(): Promise<string | null> {
  const store = await cookies();
  const cookieValue = store.get(LEARNER_COOKIE)?.value ?? null;
  if (!cookieValue || !isUuidV7(cookieValue)) return null;

  const db = getBehaviourDb();
  const session = await auth().catch(() => null);

  // No session: in production every request must be authenticated; in
  // local/preview allow the cookie through for backward-compat local dev.
  if (!session) {
    if (env.APP_ENV === "production") return null;
    return cookieValue;
  }

  // No DB to validate guardian_link against: local/preview fallback.
  if (!db) return cookieValue;

  // Check if learner is already linked to this user.
  const { rows: linked } = await db.query<{ learner_id: string }>(
    `SELECT gl.learner_id FROM app.guardian_link gl
     JOIN app.learner l ON l.id = gl.learner_id
     WHERE gl.guardian_user_id = $1::uuid AND l.public_ref = $2::uuid`,
    [session.uid, cookieValue],
  );
  if (linked.length > 0) return cookieValue;

  // Check whether this learner has any guardian_link rows at all.
  const { rows: anyLink } = await db.query<{ guardian_user_id: string }>(
    `SELECT gl.guardian_user_id FROM app.guardian_link gl
     JOIN app.learner l ON l.id = gl.learner_id
     WHERE l.public_ref = $1::uuid
     LIMIT 1`,
    [cookieValue],
  );

  if (anyLink.length === 0) {
    // Unclaimed learner: try to claim it for the signed-in parent.
    const claimed = await claimLearnerCookie(cookieValue, session.uid);
    if (claimed) return cookieValue;
    // Learner row doesn't exist yet (pre-auth with no DB row) — return cookie
    // so the consent flow can proceed and create the row.
    return cookieValue;
  }

  // Linked to someone else: shared computer case — clear the cookie.
  store.delete(LEARNER_COOKIE);
  return null;
}

/**
 * The learner for this request, creating the pseudonymous id if needed.
 *
 * In production: does NOT mint anonymous learners. Returns the currently
 * active (already owned) learner or throws when there is none. Callers in
 * the consent flow should only reach here after `POST /api/children` has
 * been used to create the learner.
 *
 * In local development or when DB/session are absent: preserves the old
 * behaviour of minting a fresh UUIDv7 cookie so local testing works.
 *
 * Callers keep the same signature (`await ensureLearnerRef()` → string).
 */
export async function ensureLearnerRef(): Promise<string> {
  const existing = await getLearnerRef();
  if (existing) return existing;

  // Try the cookie directly without validation (local/anonymous path).
  const store = await cookies();
  const raw = store.get(LEARNER_COOKIE)?.value;
  if (raw && isUuidV7(raw)) return raw;

  // Mint a new learner ref for local/preview environments.
  const learnerRef = uuidv7();
  store.set(LEARNER_COOKIE, learnerRef, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: COOKIE_MAX_AGE_SECONDS,
  });
  return learnerRef;
}

export async function getConsentState(): Promise<ConsentState | null> {
  const learnerRef = await getLearnerRef();
  if (!learnerRef) return null;
  return (await getLearningStore().getConsent(learnerRef)) ?? null;
}

export function hasScope(consent: ConsentState | null, scope: string): boolean {
  return consent?.scopes.includes(scope) ?? false;
}
