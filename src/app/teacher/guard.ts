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
 * Delete this the day a teacher session exists — and scope the roster query to
 * that teacher's class in the same change.
 */
export function assertTeacherSurfaceAllowed(): void {
  if (env.APP_ENV === "production") notFound();
}
