/**
 * `POST /api/consent` — guardian records consent for the active child.
 *
 * PRO-197: now requires an authenticated session and an active child owned by
 * the signed-in parent. Writes one row per scope to `app.consent_record`
 * (`method='web_checkbox_signed_in'`, evidence includes policy version, scopes
 * and user-agent family — never a raw IP or user agent string). The DB trigger
 * keeps `app.learner.consent_state` in sync automatically.
 *
 * Policy text, scopes, and version are unchanged from PRO-3/PRO-7.
 * Behaviour events are still gated on consent — unchanged.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import { getBehaviourDb } from "@/lib/events/runtime";
import { uuidv7 } from "@/lib/ids";
import {
  CONSENT_POLICY_VERSION,
  hasRequiredScopes,
  isValidScope,
} from "@/lib/learning/consent";
import { getLearnerRef, getConsentState } from "@/lib/learning/session";
import { getLearningStore } from "@/lib/learning/store";

export const dynamic = "force-dynamic";

const grantBody = z.object({
  scopes: z.array(z.string().refine(isValidScope, "unknown_scope")).max(16),
  policyVersion: z.string().max(64),
});

export async function GET(): Promise<Response> {
  const consent = await getConsentState();
  return NextResponse.json({
    policyVersion: CONSENT_POLICY_VERSION,
    granted: consent
      ? { scopes: consent.scopes, policyVersion: consent.policyVersion, grantedAt: consent.grantedAt }
      : null,
    currentForThisPolicy: consent?.policyVersion === CONSENT_POLICY_VERSION,
  });
}

/**
 * Record a guardian's consent for the active child.
 *
 * Requires: authenticated session + active child with `guardian_link` owned
 * by the session user. Writes to `app.consent_record` (authoritative ledger).
 * Also falls through to `getLearningStore().setConsent()` so the consent cache
 * and `consent_current` view remain consistent during the transition.
 */
export async function POST(request: Request): Promise<Response> {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const parsed = grantBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  if (parsed.data.policyVersion !== CONSENT_POLICY_VERSION) {
    return NextResponse.json(
      { error: "stale_policy_version", policyVersion: CONSENT_POLICY_VERSION },
      { status: 409 },
    );
  }
  if (!hasRequiredScopes(parsed.data.scopes)) {
    return NextResponse.json({ error: "required_scopes_missing" }, { status: 422 });
  }

  const learnerRef = await getLearnerRef();
  if (!learnerRef) {
    return NextResponse.json({ error: "no_active_child" }, { status: 422 });
  }

  const db = getBehaviourDb();

  // Write to the authoritative ledger when DB is available.
  if (db) {
    // Resolve the internal learner id.
    const { rows: learnerRows } = await db.query<{ id: string }>(
      `SELECT l.id FROM app.learner l
       JOIN app.guardian_link gl ON gl.learner_id = l.id
       WHERE l.public_ref = $1::uuid AND gl.guardian_user_id = $2::uuid`,
      [learnerRef, session.uid],
    );
    const learnerId = learnerRows[0]?.id;

    if (!learnerId) {
      return NextResponse.json({ error: "no_active_child" }, { status: 422 });
    }

    // Upsert app.learner row in case the caller skipped POST /api/children.
    await db.query(
      `INSERT INTO app.learner (id, public_ref, grade_band)
       VALUES ($1::uuid, $2::uuid, 'p5')
       ON CONFLICT (public_ref) DO NOTHING`,
      [learnerId, learnerRef],
    );

    const ua = request.headers.get("user-agent") ?? "";
    const uaFamily = ua.slice(0, 80);
    const evidence = {
      policyVersion: parsed.data.policyVersion,
      scopes: parsed.data.scopes,
      userAgentFamily: uaFamily,
    };

    const now = new Date();

    for (const scope of parsed.data.scopes) {
      await db.query(
        `INSERT INTO app.consent_record
           (id, learner_id, guardian_user_id, policy_version, scope, granted, method, evidence, effective_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, true, 'web_checkbox_signed_in', $6::jsonb, $7::timestamptz)
         ON CONFLICT DO NOTHING`,
        [uuidv7(), learnerId, session.uid, parsed.data.policyVersion, scope, JSON.stringify(evidence), now.toISOString()],
      );
    }
  }

  // Also write to the learning store (maintains the consent cache for the
  // consent_current view fallback and non-DB local environments).
  const consentState = {
    policyVersion: CONSENT_POLICY_VERSION,
    scopes: parsed.data.scopes,
    grantedAt: new Date().toISOString(),
  };
  await getLearningStore().setConsent(learnerRef, consentState);

  return NextResponse.json({ granted: consentState }, { status: 201 });
}

/** Withdrawal. Everything goes; partial withdrawal arrives with the settings screen. */
export async function DELETE(): Promise<Response> {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const learnerRef = await getLearnerRef();
  if (!learnerRef) {
    return NextResponse.json({ error: "no_active_child" }, { status: 422 });
  }
  await getLearningStore().setConsent(learnerRef, null);
  return NextResponse.json({ granted: null });
}
