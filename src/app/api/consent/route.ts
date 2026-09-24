import { NextResponse } from "next/server";
import { z } from "zod";

import { getBehaviourDb } from "@/lib/events/runtime";
import { uuidv7 } from "@/lib/ids";
import {
  CONSENT_POLICY_VERSION,
  hasRequiredScopes,
  isValidScope,
} from "@/lib/learning/consent";
import { ensureLearnerRef, getConsentState } from "@/lib/learning/session";
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
    /** A consent given against older wording does not carry over (PRO-3 §2.2). */
    currentForThisPolicy: consent?.policyVersion === CONSENT_POLICY_VERSION,
  });
}

/**
 * Record a guardian's choices.
 *
 * The required scopes are checked here and not only in the form: a request that
 * skips the screen must not be able to create a half-consented learner who then
 * uses the product anyway.
 */
export async function POST(request: Request): Promise<Response> {
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

  const learnerRef = await ensureLearnerRef();
  const consent = {
    policyVersion: CONSENT_POLICY_VERSION,
    scopes: parsed.data.scopes,
    grantedAt: new Date().toISOString(),
  };
  await getLearningStore().setConsent(learnerRef, consent);

  const db = getBehaviourDb();
  if (db) {
    await db.query(
      `INSERT INTO app.learner (id, public_ref, grade_band)
       VALUES ($1::uuid, $2::uuid, 'p5')
       ON CONFLICT (public_ref) DO NOTHING`,
      [uuidv7(), learnerRef],
    );
  }

  return NextResponse.json({ granted: consent }, { status: 201 });
}

/** Withdrawal. Everything goes; partial withdrawal arrives with the settings screen. */
export async function DELETE(): Promise<Response> {
  const learnerRef = await ensureLearnerRef();
  await getLearningStore().setConsent(learnerRef, null);
  return NextResponse.json({ granted: null });
}
