import { NextResponse, type NextRequest } from "next/server";

import { env } from "@/lib/env";

/**
 * The production teacher-surface guard, moved in front of rendering.
 *
 * There is no teacher sign-in yet (PRO-12), so the production tier must not
 * serve `/teacher/*` at all — those pages read a child's nickname and nothing
 * on them distinguishes a teacher from a stranger with the URL. That rule was
 * already enforced by `assertTeacherSurfaceAllowed()` inside each page. This
 * file enforces it one layer earlier, for two reasons.
 *
 * 1. **It answers 404 for real.** A `notFound()` raised inside a page cannot
 *    change the status code once the response has started streaming, and
 *    `src/app/teacher/loading.tsx` is a Suspense boundary above every teacher
 *    page, so the headers are always gone before the page decides (PRO-99;
 *    `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/loading.md`
 *    §Status Codes). Production therefore rendered the "not found" body with a
 *    200, which makes "production must 404 on /teacher" unassertable by
 *    monitoring. Proxy runs before any body is written, so the status is ours.
 *
 * 2. **It fails closed for pages nobody remembered.** The in-page guard is
 *    opt-in: a fifth teacher page that forgets the call ships a child's data to
 *    production, and nothing in the build catches it. A path prefix covers the
 *    subtree whether or not the page cooperates. The in-page calls stay as
 *    defence in depth — Server Functions can be reached without re-running
 *    proxy (see the Execution-order note in `proxy.md`), so the page-level
 *    check is not redundant.
 *
 * Local and preview fall through untouched: that is where the teacher screens
 * are reviewed, and they keep their loading skeletons and their soft 404 on a
 * mistyped id. See `docs/adr/0006-teacher-route-status-codes.md` for why that
 * half is deliberately left alone, and for the monitoring contract per tier.
 *
 * Delete this the day a teacher session exists, together with `guard.ts`.
 */

/**
 * A path no `page.tsx` produces, so Next.js serves its own 404 for it —
 * which means `src/app/not-found.tsx`, the same page any unknown URL gets, at
 * a genuine 404. Rewriting (not redirecting) keeps the original URL in the bar,
 * so a probe cannot tell `/teacher/review` apart from any other typo.
 *
 * `src/proxy.test.ts` fails if a route ever starts matching this path.
 */
export const HIDDEN_TEACHER_REWRITE_TARGET = "/teacher-surface-not-served";

export function proxy(request: NextRequest) {
  if (env.APP_ENV !== "production") return NextResponse.next();

  return NextResponse.rewrite(new URL(HIDDEN_TEACHER_REWRITE_TARGET, request.url));
}

export const config = {
  matcher: ["/teacher", "/teacher/:path*"],
};
