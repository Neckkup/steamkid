/**
 * Who the server thinks sent this batch.
 *
 * The client never names the learner. It carries an HttpOnly cookie holding
 * `app.learner.public_ref` — the one identifier data-schema decision 2 allows
 * outside our infrastructure — and the server exchanges it for the internal
 * `app.learner.id` that every table is keyed on. A browser that could name the
 * learner could also name a different one, and `public_ref` is rotatable
 * precisely because no foreign key points at it.
 *
 * A cookie that matches no learner row resolves to null and nothing is stored.
 * That is the same fail-closed answer as "no consent", and for the same reason:
 * we do not create a learner as a side effect of receiving telemetry. A learner
 * row is created by the consent flow, after a guardian has actually agreed.
 */

import type { SqlExecutor } from "@/lib/db/sql";

/**
 * Must stay in step with `LEARNER_COOKIE` in `src/lib/learning/session.ts`
 * (PRO-6). Duplicated as a literal rather than imported so the ingest path does
 * not depend on the product's session module, which pulls in `next/headers`.
 */
export const LEARNER_COOKIE = "sk_learner";

const COOKIE_VALUE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pull our cookie out of a `Cookie` header without parsing anyone else's. */
export function readLearnerCookie(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== LEARNER_COOKIE) continue;

    const value = decodeURIComponent(part.slice(separator + 1).trim());
    return COOKIE_VALUE_RE.test(value) ? value : null;
  }
  return null;
}

/** `app.learner.id` for this `public_ref`, or null when there is no such learner. */
export async function resolveLearnerId(
  sql: SqlExecutor,
  publicRef: string,
): Promise<string | null> {
  const { rows } = await sql.query<{ id: string }>(
    `SELECT id FROM app.learner
     WHERE public_ref = $1::uuid AND deleted_at IS NULL AND status = 'active'`,
    [publicRef],
  );
  return rows[0]?.id ?? null;
}
