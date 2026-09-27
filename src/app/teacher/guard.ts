import { notFound } from "next/navigation";

import { requireTeacher } from "@/lib/learning/teacher-session";

/**
 * Server-side guard for every teacher page and Server Function.
 *
 * Calls `requireTeacher()` (session + allowlist) and throws 404 when the
 * caller is not an authenticated, allowlisted teacher. The proxy already
 * redirects/403s at the edge, but Server Functions can be reached without
 * a page load, so this call is kept as defence in depth.
 *
 * Returns the teacher identity for callers that need the user id (e.g. to
 * write pii_access_log rows).
 */
export async function assertTeacherSurfaceAllowed() {
  const teacher = await requireTeacher();
  if (!teacher) notFound();
  return teacher;
}
