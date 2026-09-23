# 0006 — Teacher routes: a real 404 in production, a soft 404 everywhere else

- Status: accepted
- Date: 2026-09-23
- Decider: CTO
- Issue: PRO-99 (follows PRO-98)

## Context

`/teacher/*` answered HTTP **200** for pages that render "ไม่เจอหน้านี้". Two
different callers produced it:

1. A well-formed `verdictId` that names no row. The page calls `notFound()`
   after the query.
2. `APP_ENV=production`. `src/app/teacher/guard.ts` calls `notFound()` on every
   teacher route because there is no teacher sign-in yet (PRO-12), so those
   screens must not be served on the tier that holds real children's data.

Case 2 is the one that matters. It is a privacy control, and a privacy control
that cannot be asserted from outside is a privacy control nobody can prove is
on. Anyone writing "production must answer 404 for /teacher" got a red check
against a guard that was in fact working correctly.

### Why it was 200

Not a bug in our code. Next.js cannot set a status code after the response body
has started streaming, and a Suspense fallback anywhere above the page starts
that stream:

> The response body starts streaming when a Suspense fallback renders (for
> example, a `loading.tsx`) or when a Server Component suspends under a
> `Suspense` boundary. ... To start streaming, the response headers must be set.
> This is why it is not possible to change the status code after streaming
> started.
>
> — `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/loading.md`, §Status Codes (Next 16.3.5)

`src/app/teacher/loading.tsx` is a boundary over the whole `/teacher` subtree,
so the headers are always gone before any page decides. QA confirmed this by
removing the `loading.tsx` files one layer at a time: the status only became 404
once **all** of them were gone. There is no arrangement of `loading.tsx` that
yields both a loading state and a 404 — the choice is one or the other, per
subtree.

## Decision

Split the problem along the line where it actually costs something.

**Production: enforce the guard in `src/proxy.ts`, before rendering.** When
`APP_ENV === "production"`, `/teacher` and `/teacher/:path*` are rewritten to a
path no route serves, so Next.js answers its own 404 — real status, and the same
`src/app/not-found.tsx` body any unknown URL gets. No database access, no
per-request cost worth measuring (3 ms in dev, and proxy runs before render).

**Local and preview: keep the loading skeletons, accept the soft 404.** A
mistyped `verdictId` there still returns 200 with the "ไม่เจอหน้านี้" body from
`src/app/teacher/not-found.tsx`. This is a deliberate, permanent trade: teacher
screens are data-heavy and the skeleton is real UX on the tier where those
screens are actually reviewed, whereas the status code on a mistyped id costs
nothing real. Next.js already attaches `<meta name="robots" content="noindex">`
to a streamed 404, so SEO is not exposed either way.

**Monitoring contract** — the thing this ADR exists to make writable:

| Tier | URL | Assert |
| --- | --- | --- |
| production | `/teacher`, `/teacher/<anything>` | HTTP `404` |
| local, preview | `/teacher/review/<valid uuid, no row>` | HTTP `200` **and** body contains "ไม่เจอหน้านี้" — do **not** assert on status |
| any | `/learn` | HTTP `200` (control: distinguishes "guard working" from "site down") |

The production row is now a true statement about a privacy control. Any check
that asserts 404 on local or preview is asserting something this ADR says we
deliberately do not provide, and will fail.

### The second reason, which outgrew the status code

The in-page guard is **opt-in**: four pages each remember to call
`assertTeacherSurfaceAllowed()`. A fifth teacher page that forgets ships a
child's nickname to production, and no build, type check, or test catches it.
A path prefix in proxy covers the subtree whether or not the page cooperates.

So `proxy.ts` is now the primary production guard and `guard.ts` is defence in
depth — both stay. They are not redundant: Next's own docs warn that Server
Functions are POSTs to the route that declares them and a matcher change can
silently drop proxy coverage, so the in-page check must survive.

## Alternatives rejected

**Document the 200 and change monitoring's expectations instead (no code).**
Cheapest, and correct as far as Next.js is concerned. Rejected because it leaves
the production privacy guard unassertable from outside, and because it does
nothing about the opt-in-guard gap above. The documentation half of this option
was kept — it is the table above.

**Query Postgres in proxy so every nonexistent `verdictId` 404s on every tier.**
This is the only option that fixes case 1 too. Rejected: it puts a database
round trip in front of every `/teacher/review/*` request, and Next's own proxy
guidance is "keep proxy checks fast, and avoid fetching full content there". We
would be paying a permanent hot-path cost to fix a cosmetic status code on the
two tiers where nobody is watching. Revisit only if an external requirement
demands a true 404 for a missing row.

**Delete the `loading.tsx` files under `/teacher`.** Would give real 404s on all
tiers with no new files. Rejected: it trades a visible loading state on every
teacher screen, on the tiers where teacher screens are reviewed, for a status
code on a typo.

## Cost if this is wrong

Low, in both directions.

- Backing this out is deleting `src/proxy.ts` and `src/proxy.test.ts`. The
  in-page `assertTeacherSurfaceAllowed()` calls were never removed, so the
  production guard keeps working — it just goes back to answering 200.
- Going further later (option 3) is adding a lookup to a file that already
  exists and already has the matcher wired.
- The one sharp edge is the rewrite target. If a future `page.tsx` ever matches
  `/teacher-surface-not-served`, the guard silently degrades to 200.
  `src/proxy.test.ts` fails the build if that happens.
- Proxy is now an app-level convention file this repo did not have. Anything
  added to it runs on every matched request, including Server Function POSTs.
  Keep it to path-and-env checks; authorization belongs in the page and in the
  Server Function, not only here.

## Verification

`APP_ENV=production`, Next 16.3.5, isolated dev server:

```
/teacher                                                   404
/teacher/review                                            404
/teacher/review/00000000-0000-7000-8000-000000000000       404
/teacher/review/not-a-uuid                                 404
/teacher/abc                                               404
/learn                                                     200
/definitely-not-a-route                                    404
```

`APP_ENV=local`, unchanged as intended:

```
/teacher                                                   200
/teacher/review                                            200
/teacher/review/00000000-0000-7000-8000-000000000000       200
```

The production 404 body is byte-comparable to the 404 for any unknown URL. The
only occurrence of "teacher" in it is the path the requester typed, echoed back
in the RSC payload exactly as `/definitely-not-a-route` echoes its own; the
internal rewrite target never appears. A probe cannot tell that teacher screens
exist.
