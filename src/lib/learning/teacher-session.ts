/**
 * Teacher authentication helper (PRO-197).
 *
 * A teacher is a signed-in account with `role IN ('teacher', 'admin')` whose
 * email is also in the `TEACHER_EMAILS` allowlist at the time of the request.
 * The allowlist is checked server-side (the JWT carries only uid + role).
 * Removing an email from the env var revokes access on the next request.
 *
 * The old `sk_teacher` cookie path and `getTeacherIdentity()` are deleted.
 * All callers now use `requireTeacher()`. The proxy and every Server Function
 * that reads child PII call this rather than relying on the proxy alone.
 */

import { auth } from "@/auth";
import { getBehaviourDb } from "@/lib/events/runtime";
import { env } from "@/lib/env";
import { uuidv7 } from "@/lib/ids";

export interface TeacherIdentity {
  readonly userId: string;
  readonly email: string;
}

function teacherEmailsFromEnv(): string[] {
  if (!env.TEACHER_EMAILS) return [];
  return env.TEACHER_EMAILS.split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Returns the authenticated teacher identity, or null.
 *
 * Returns null when:
 * - there is no session
 * - the session role is not `teacher` or `admin`
 * - the account email is not in the `TEACHER_EMAILS` allowlist
 * - the database is unavailable
 */
export async function requireTeacher(): Promise<TeacherIdentity | null> {
  const session = await auth().catch(() => null);
  if (!session) return null;
  if (!["teacher", "admin"].includes(session.role)) return null;

  const db = getBehaviourDb();
  if (!db) return null;

  const { rows } = await db.query<{ email: string }>(
    `SELECT email FROM identity.user_account WHERE id = $1::uuid`,
    [session.uid],
  );
  const email = rows[0]?.email;
  if (!email) return null;

  if (!teacherEmailsFromEnv().includes(email.toLowerCase())) return null;

  return { userId: session.uid, email };
}

/**
 * Write a PII access record when a teacher page reads child nicknames.
 *
 * `learnerIds` should be the internal `app.learner.id` values, not public_refs.
 */
export async function logPiiAccess(
  teacherUserId: string,
  learnerIds: string[],
  purpose: string,
): Promise<void> {
  const db = getBehaviourDb();
  if (!db || learnerIds.length === 0) return;

  const values = learnerIds
    .map((_, i) => `($${i * 4 + 1}::uuid, $${i * 4 + 2}::uuid, 'user', $${i * 4 + 3}, now())`)
    .join(", ");

  const params: unknown[] = [];
  for (const learnerId of learnerIds) {
    params.push(uuidv7(), teacherUserId, learnerId, purpose);
  }

  await db.query(
    `INSERT INTO identity.pii_access_log (id, actor_user_id, actor_kind, learner_id, purpose, accessed_at)
     VALUES ${values}`,
    params,
  );
}

/**
 * Convenience wrapper for teacher pages that only have public_refs.
 *
 * Resolves each `public_ref` to its internal `app.learner.id` then delegates
 * to `logPiiAccess`. Refs that do not resolve (e.g. demo data) are silently
 * skipped — the log is best-effort and must not block the page render.
 */
export async function logPiiAccessByRefs(
  teacherUserId: string,
  publicRefs: string[],
  purpose: string,
): Promise<void> {
  const db = getBehaviourDb();
  if (!db || publicRefs.length === 0) return;

  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM app.learner WHERE public_ref = ANY($1::uuid[])`,
    [publicRefs],
  );

  const learnerIds = rows.map((r) => r.id);
  if (learnerIds.length === 0) return;

  await logPiiAccess(teacherUserId, learnerIds, purpose);
}
