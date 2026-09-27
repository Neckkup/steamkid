/**
 * `POST /api/children/active { learnerRef }` — switch the active child.
 *
 * Ownership is verified: the signed-in parent must have a `guardian_link` for
 * the requested learner. Returns 404 for unknown or unowned learners, 401 for
 * unauthenticated requests, 204 on success.
 */

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import { getBehaviourDb } from "@/lib/events/runtime";

import { LEARNER_COOKIE } from "@/lib/learning/session";

export const dynamic = "force-dynamic";

const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 180;

const body = z.object({
  learnerRef: z.string().uuid(),
});

export async function POST(request: Request): Promise<Response> {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const { learnerRef } = parsed.data;

  const db = getBehaviourDb();
  if (!db) {
    return NextResponse.json({ error: "database_unavailable" }, { status: 503 });
  }

  // Verify ownership.
  const { rows } = await db.query<{ public_ref: string }>(
    `SELECT l.public_ref FROM app.guardian_link gl
     JOIN app.learner l ON l.id = gl.learner_id
     WHERE gl.guardian_user_id = $1::uuid
       AND l.public_ref = $2::uuid
       AND l.status = 'active'`,
    [session.uid, learnerRef],
  );

  if (rows.length === 0) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const cookieStore = await cookies();
  cookieStore.set(LEARNER_COOKIE, learnerRef, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: COOKIE_MAX_AGE_SECONDS,
  });

  return new NextResponse(null, { status: 204 });
}
