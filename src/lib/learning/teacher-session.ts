/**
 * Which teacher is on the other end of a request.
 *
 * **This is not authentication, and the production tier does not accept it.**
 * PRO-12 provisions the auth provider; until then there is nothing on a request
 * that distinguishes a teacher from a stranger who guessed a cookie, and the
 * thing being guarded here is a teacher's power to change a child's grade.
 *
 * So the rule is the same one `src/app/teacher/guard.ts` already applies to the
 * teacher screens, and it is deliberately the blunt one: **in `production`
 * there is no teacher, and every endpoint that needs one refuses.** Local and
 * preview read the id from an HttpOnly cookie, which is enough to review the
 * screens and to run the flow end to end, and not enough to be mistaken for a
 * login.
 *
 * Two things still hold even in local and preview, because they are enforced by
 * the database rather than by this file:
 *
 *   - the id must be a real `identity.user_account` row whose `role` is
 *     `teacher` or `admin` — a composite foreign key on
 *     `(teacher_user_id, teacher_role)` rejects anything else
 *   - a correction is an append-only row that records who made it
 *
 * Delete this file the day a teacher session exists, and scope corrections to
 * that teacher's own class in the same change.
 */

import { cookies } from "next/headers";

import { env } from "@/lib/env";

export const TEACHER_COOKIE = "sk_teacher";

export type TeacherIdentity =
  | { readonly kind: "teacher"; readonly userId: string }
  /** No teacher sign-in exists in this tier. Not "signed out" — unavailable. */
  | { readonly kind: "unavailable" }
  | { readonly kind: "anonymous" };

export async function getTeacherIdentity(): Promise<TeacherIdentity> {
  if (env.APP_ENV === "production") return { kind: "unavailable" };

  const store = await cookies();
  const userId = store.get(TEACHER_COOKIE)?.value;
  return userId ? { kind: "teacher", userId } : { kind: "anonymous" };
}
