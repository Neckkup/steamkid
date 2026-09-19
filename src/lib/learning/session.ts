/**
 * Who the server thinks is on the other end of the request.
 *
 * **This is not authentication and does not pretend to be.** PRO-3 buys auth
 * (`mvp-scope` §4) and the account for it is still being provisioned in PRO-12.
 * What exists here is the one piece every other part of the product needs
 * before that lands: a pseudonymous `learnerRef` the server reads from an
 * HttpOnly cookie, so that
 *
 *   - behaviour events are attributed server-side and the client never sends,
 *     and therefore can never forge, a learner id (PRO-3 data-schema rule 1)
 *   - a child's work is scoped to that child rather than global
 *
 * When the auth provider arrives, `getLearnerRef` resolves the provider subject
 * to `app.learner.id` and every caller keeps working unchanged. The cookie is
 * HttpOnly and SameSite=Lax specifically so that swap does not have to walk
 * back a value that leaked into client JavaScript in the meantime.
 */

import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";

import { getLearningStore, type ConsentState } from "./store";

export const LEARNER_COOKIE = "sk_learner";

const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 180;

/** The learner for this request, or null when this browser has never been here. */
export async function getLearnerRef(): Promise<string | null> {
  const store = await cookies();
  return store.get(LEARNER_COOKIE)?.value ?? null;
}

/**
 * The learner for this request, creating the pseudonymous id if needed.
 *
 * Only callable from a route handler or server action — a server component
 * cannot set cookies, and silently failing to persist the id would hand every
 * page load a different learner.
 */
export async function ensureLearnerRef(): Promise<string> {
  const store = await cookies();
  const existing = store.get(LEARNER_COOKIE)?.value;
  if (existing) return existing;

  const learnerRef = randomUUID();
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
