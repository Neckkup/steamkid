import { notFound } from "next/navigation";

import { env } from "@/lib/env";

/**
 * No teacher sign-in, no teacher screens in production.
 *
 * These pages read `identity.learner_profile.display_name`, which the PRO-3
 * consent/PII policy lists as a child's nickname that must never leave our
 * systems. Until PRO-12 provisions auth there is nothing on these routes that
 * distinguishes a teacher from a stranger with the URL, so the production tier
 * answers 404 instead. Local and preview still render, which is where the
 * screens are reviewed.
 *
 * This is no longer the only enforcement point, and no longer the outermost
 * one: `src/proxy.ts` 404s the whole `/teacher` subtree on that tier before
 * anything renders, which is what makes the production guard answer a real 404
 * rather than a 200 carrying a "not found" body (PRO-99,
 * `docs/adr/0006-teacher-route-status-codes.md`). Keep this call in every
 * teacher page anyway — proxy coverage follows a matcher, and a Server Function
 * reached on a path the matcher stops covering would otherwise run unguarded.
 *
 * Delete this the day a teacher session exists — and scope the roster query to
 * that teacher's class in the same change.
 */
export function assertTeacherSurfaceAllowed(): void {
  if (env.APP_ENV === "production") notFound();
}
