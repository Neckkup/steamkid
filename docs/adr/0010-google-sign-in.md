# 0010 — Google sign-in: Auth.js v5, parent↔child, consent ledger, teacher allowlist

- Status: accepted
- Date: 2026-09-27
- Decider: CTO
- Issue: PRO-197 (implements PRO-196)
- Supersedes: [ADR 0006](0006-teacher-route-status-codes.md) (proxy guard mechanism)

## Context

Teachers needed a real sign-in rather than the `sk_teacher` cookie hack. Guardians
needed to own children's learner refs so consent is linked to a verified identity
rather than a browser cookie that can be cleared. The consent model needed an
append-only ledger (`app.consent_record`) rather than a mutable cache
(`app.learner_consent_cache`), and unclaimed cookie-only sessions needed a
migration path when a guardian signs in for the first time.

All of these changes share the same sign-in infrastructure, so they ship together.

## Decisions

### D1 — Auth.js v5 with Google provider, JWT strategy, no adapter

`next-auth@5.0.0-beta.32` with `GoogleProvider`. Session strategy is `"jwt"` so
there is no auth-side database writes. The JWT is a short-lived, httpOnly, signed
cookie. No Auth.js adapter is wired — user persistence is handled explicitly in
the `signIn` callback (D2).

Rejected: a full Auth.js database adapter (Prisma, Drizzle, or raw PG). Adapters
write multiple tables on every sign-in and add an auth-owned schema slice. Our
identity schema already has `identity.user_account`; writing through an adapter
would either duplicate data or require a custom adapter with no library support.

### D2 — Custom upsert in signIn callback; no Auth.js user table

The `signIn` callback executes:

```sql
INSERT INTO identity.user_account (auth_provider, auth_subject_id, email, role)
VALUES ('google', $sub, $email, 'guardian')
ON CONFLICT (auth_provider, auth_subject_id) DO UPDATE SET email = EXCLUDED.email
RETURNING id, role
```

If the returned `role` is `'guardian'` and the email is in `TEACHER_EMAILS`, the
role is promoted to `'teacher'`. Role is never demoted. Sign-in is rejected if
`profile.email_verified` is false.

### D3 — JWT and session carry only `uid` and `role`

The JWT payload contains only `{ uid: string, role: "guardian"|"teacher"|"admin" }`.
The session object carries those same two fields plus `user: {}` (empty, stripped
of everything Auth.js would otherwise put there — name, email, image).

No email, no display name, no Google sub ever appears in the JWT, the session
object, `console.log`, Sentry, or Langfuse. The session is safe to expose to
client code.

### D4 — Teacher role via TEACHER_EMAILS allowlist, checked server-side

`TEACHER_EMAILS` is a comma-separated env var. The check happens in two places:

1. `signIn` callback — promotes `guardian → teacher` at sign-in.
2. `requireTeacher()` in `src/lib/learning/teacher-session.ts` — re-reads the
   email from `identity.user_account` on every request and confirms it is still
   in the allowlist.

The double-check means removing an email from `TEACHER_EMAILS` revokes access on
the next request without requiring a new sign-in or a database change. The JWT
alone cannot revoke access because JWTs are not invalidated.

Rejected: storing teacher emails in a database table. An env var is simpler for
a small, known set; it can be changed in the Vercel dashboard without a migration.
Revisit when the teacher count grows or when self-service teacher management is
needed.

### D5 — Parent↔child via `app.guardian_link`

Guardians own learner refs through rows in `app.guardian_link`. The `POST
/api/children` endpoint creates a new `app.learner` + `identity.learner_profile`
+ `guardian_link(relationship='parent', verified_at=now())`. The `sk_learner`
cookie is set to the new learner ref.

`GET /api/children` returns the guardian's linked children. `POST
/api/children/active` switches the active learner ref cookie after an ownership
check.

### D6 — `getLearnerRef()` and `ensureLearnerRef()` in session.ts

`getLearnerRef()` is the authoritative way to resolve "which learner is this
request for?" It checks the `sk_learner` cookie, then the session, then
`guardian_link`:

| Session | DB | Cookie → guardian_link | Result |
|---|---|---|---|
| none | none | — | cookie value (local dev fallback) |
| none | present | — | null (production requires session) |
| present | none | — | cookie value (local dev fallback) |
| present | present | cookie owned by this user | cookie value |
| present | present | cookie unowned (zero links) | claim (D7), then cookie |
| present | present | cookie owned by other user | clear cookie, null |

`ensureLearnerRef()` calls `getLearnerRef()` first; if null, falls back to a
direct cookie read, and mints a new UUID only in local/preview (never in
production).

### D7 — Cookie-learner claim on first authenticated request

When a returning guardian signs in and the cookie refs a learner that has no
guardian_link, `claimLearnerCookie()` runs:

1. `INSERT INTO app.guardian_link ... ON CONFLICT DO NOTHING`
2. Reads all scopes from `app.learner_consent_cache` for that learner
3. Inserts each scope into `app.consent_record` with `method='claimed_on_signin'`

This migrates any consent recorded before sign-in into the authoritative ledger.

### D8 — `app.consent_record` is the authoritative consent ledger

`POST /api/consent` requires a valid session and an active child owned by the
session user. It writes one row per scope to `app.consent_record` with
`method='web_checkbox_signed_in'`. The table is append-only; consent is queried
by checking for the existence of a row.

`app.learner_consent_cache` remains as a pre-auth fallback read path only.
New consent is never written there for authenticated users.

### D9 — `app.learner_consent_cache` is a pre-auth read fallback

The cache continues to hold consent recorded before sign-in (e.g., from the
onboarding flow). Once claimed (D7) those rows are mirrored into
`app.consent_record`. No new rows are written to the cache for authenticated
sessions.

### D10 — Sentry and Langfuse never receive email, name, or Google sub

`Sentry.setUser()` is never called. The `scrubEvent` function in
`src/lib/observability/sentry-options.ts` is the backstop. Langfuse traces use
the `uid` (an opaque UUID) and the `learnerRef` as identifiers; neither is tied
to a real name or email in the trace payload.

## Consequences

- Teacher access is controlled by an env var; adding or removing a teacher is a
  Vercel dashboard change (no code, no migration).
- Anonymous (cookie-only) learners can be claimed retroactively when a guardian
  signs in; consent from before sign-in is preserved.
- The proxy guard (`src/proxy.ts`) is now session-based: unauthenticated → redirect
  to `/signin`, authenticated non-teacher → 403. The old production-only 404 rewrite
  is removed (supersedes ADR 0006's mechanism, though the in-page guard remains).
- JWT and session never carry PII; a client-side `useSession()` call is safe to
  log or trace.
