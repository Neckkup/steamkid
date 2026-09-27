/**
 * `GET /api/children` — list children linked to the signed-in parent.
 * `POST /api/children` — create a child profile and link it to the parent.
 *
 * Contract Coder builds against (shapes are stable):
 *   GET  → { children: [{ learnerRef, nickname, birthYearMonth, hasConsent, active }] }
 *   POST { nickname, birthYearMonth: "YYYY-MM" } → 201 { learnerRef }
 *
 * All endpoints return 401 without a session.
 */

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import { getBehaviourDb } from "@/lib/events/runtime";
import { uuidv7 } from "@/lib/ids";

import { LEARNER_COOKIE } from "@/lib/learning/session";

export const dynamic = "force-dynamic";

const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 180;

const createBody = z.object({
  nickname: z.string().min(1).max(64),
  birthYearMonth: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/, "must be YYYY-MM"),
});

export async function GET(): Promise<Response> {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const db = getBehaviourDb();
  if (!db) return NextResponse.json({ children: [] });

  const cookieStore = await cookies();
  const activeLearnerRef = cookieStore.get(LEARNER_COOKIE)?.value ?? null;

  const { rows } = await db.query<{
    public_ref: string;
    display_name: string;
    birth_year_month: string;
    has_consent: boolean;
  }>(
    `SELECT l.public_ref, lp.display_name, to_char(lp.birth_year_month, 'YYYY-MM') AS birth_year_month,
            app.has_consent(l.id, 'service_operation') AS has_consent
     FROM app.guardian_link gl
     JOIN app.learner l ON l.id = gl.learner_id
     JOIN identity.learner_profile lp ON lp.learner_id = l.id
     WHERE gl.guardian_user_id = $1::uuid
       AND l.status = 'active'
     ORDER BY l.created_at`,
    [session.uid],
  );

  const children = rows.map((row) => ({
    learnerRef: row.public_ref,
    nickname: row.display_name,
    birthYearMonth: row.birth_year_month,
    hasConsent: row.has_consent,
    active: row.public_ref === activeLearnerRef,
  }));

  return NextResponse.json({ children });
}

export async function POST(request: Request): Promise<Response> {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const parsed = createBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", details: parsed.error.flatten() }, { status: 400 });
  }

  const db = getBehaviourDb();
  if (!db) {
    return NextResponse.json({ error: "database_unavailable" }, { status: 503 });
  }

  const { nickname, birthYearMonth } = parsed.data;
  const learnerId = uuidv7();
  const learnerRef = uuidv7();

  // birth_year_month is stored as the first day of the month.
  const birthDate = `${birthYearMonth}-01`;

  await db.query(
    `INSERT INTO app.learner (id, public_ref, grade_band)
     VALUES ($1::uuid, $2::uuid, 'p5')`,
    [learnerId, learnerRef],
  );

  await db.query(
    `INSERT INTO identity.learner_profile (learner_id, display_name, birth_year_month)
     VALUES ($1::uuid, $2, $3::date)`,
    [learnerId, nickname, birthDate],
  );

  await db.query(
    `INSERT INTO app.guardian_link (guardian_user_id, learner_id, relationship, verified_at)
     VALUES ($1::uuid, $2::uuid, 'parent', now())`,
    [session.uid, learnerId],
  );

  // Set as the active child.
  const cookieStore = await cookies();
  cookieStore.set(LEARNER_COOKIE, learnerRef, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: COOKIE_MAX_AGE_SECONDS,
  });

  return NextResponse.json({ learnerRef }, { status: 201 });
}
