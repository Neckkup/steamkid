/**
 * Auth gate for all protected routes (PRO-197, PRO-198).
 *
 * Teacher routes (/teacher/*):
 *   - No session → redirect to /signin with callbackUrl.
 *   - Signed in but not a teacher → 403 /forbidden.
 *   - Teacher → pass through.
 *
 * Learner routes (/learn/*, /me, /results/*, /consent):
 *   - No session → redirect to /signin with callbackUrl.
 *   - Signed in but no active child (sk_learner cookie absent) → /children.
 *   - Otherwise → pass through.
 *
 * Defence in depth: the proxy does not replace the in-page `requireTeacher()`
 * calls because Server Functions can be reached without re-running the proxy.
 */

import { NextResponse, type NextRequest } from "next/server";

import { auth } from "@/auth";

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;

  // ── Teacher surface ──────────────────────────────────────────────────────
  if (path === "/teacher" || path.startsWith("/teacher/")) {
    const session = await auth();

    if (!session) {
      const callbackUrl = encodeURIComponent(path + request.nextUrl.search);
      return NextResponse.redirect(new URL(`/signin?callbackUrl=${callbackUrl}`, request.url));
    }

    if (!["teacher", "admin"].includes(session.role)) {
      return NextResponse.rewrite(new URL("/forbidden", request.url), { status: 403 });
    }

    return NextResponse.next();
  }

  // ── Learner surface ───────────────────────────────────────────────────────
  const isLearnerRoute =
    path === "/learn" ||
    path.startsWith("/learn/") ||
    path === "/me" ||
    path.startsWith("/results/") ||
    path === "/consent";

  if (isLearnerRoute) {
    const session = await auth();

    if (!session) {
      const callbackUrl = encodeURIComponent(path + request.nextUrl.search);
      return NextResponse.redirect(new URL(`/signin?callbackUrl=${callbackUrl}`, request.url));
    }

    const activeLearner = request.cookies.get("sk_learner")?.value;
    if (!activeLearner) {
      return NextResponse.redirect(new URL("/children", request.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/teacher",
    "/teacher/:path*",
    "/learn",
    "/learn/:path*",
    "/me",
    "/results/:path*",
    "/consent",
  ],
};
