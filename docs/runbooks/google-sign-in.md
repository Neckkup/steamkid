# Runbook: Google sign-in

Auth.js v5 with Google OAuth. Teachers and guardians both sign in here.

## Prerequisites

- Google Cloud project with the OAuth consent screen configured
- `TEACHER_EMAILS` env var — comma-separated list of teacher email addresses
- `AUTH_SECRET` env var — 32+ random bytes, base64-encoded (`openssl rand -base64 32`)

## Google Console setup

1. Go to [console.cloud.google.com](https://console.cloud.google.com) → **APIs & Services** → **Credentials**.
2. Click **Create credentials** → **OAuth client ID**.
3. Application type: **Web application**.
4. Name: `steamkid` (or any label you recognise).
5. Under **Authorized redirect URIs** add all of the URIs below — one per deployment tier.

### Redirect URIs

| Tier | URI |
|---|---|
| local dev | `http://localhost:3000/api/auth/callback/google` |
| Vercel preview | `https://<preview-deployment-url>.vercel.app/api/auth/callback/google` |
| Production | `https://steamkid.app/api/auth/callback/google` |

For preview deployments Vercel generates a new subdomain per push. Set
`AUTH_REDIRECT_PROXY_URL=https://steamkid.app` and add the production URI as the
single callback; Auth.js will proxy the OAuth redirect through the production
domain so the wildcard preview URL does not need to be registered each time.

6. Click **Create**. Copy **Client ID** and **Client Secret**.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `AUTH_GOOGLE_ID` | yes | OAuth Client ID from Google Console |
| `AUTH_GOOGLE_SECRET` | yes | OAuth Client Secret from Google Console |
| `AUTH_SECRET` | yes | Cookie signing key — `openssl rand -base64 32` |
| `TEACHER_EMAILS` | no | Comma-separated teacher email addresses (blank = no teachers) |
| `AUTH_REDIRECT_PROXY_URL` | no | Proxy base URL for preview deployments (see above) |

Set these in **Vercel → Project → Settings → Environment Variables**. All are safe
to mark as "production + preview + development" except `AUTH_GOOGLE_SECRET` and
`AUTH_SECRET`, which should be scoped to each tier separately.

## Adding a teacher

1. Have the person sign in at `https://steamkid.app/api/auth/signin/google` so
   their row exists in `identity.user_account`.
2. In Vercel: **Settings → Environment Variables → `TEACHER_EMAILS`** → add their
   email to the comma-separated list.
3. Click **Save** and **Redeploy** (or wait for the next deploy).

The role column in `identity.user_account` is promoted from `guardian` to `teacher`
on the next sign-in, and re-checked on every `/teacher/*` request by
`requireTeacher()`. No migration is needed.

## Removing a teacher

1. Remove their email from `TEACHER_EMAILS` in Vercel.
2. Redeploy.

Access is revoked on the next request — the JWT is not invalidated, but
`requireTeacher()` re-reads the allowlist on every call and returns null if the
email is no longer present. No database change is needed.

## Signing in

Users visit `/api/auth/signin/google` (or any page that redirects there). After
consent, they land at `/` (or the `callbackUrl` query parameter if set by the
redirect).

Teacher pages (`/teacher/*`) require a session with `role = teacher` or `admin`.
Unauthenticated requests are redirected to `/signin?callbackUrl=<path>`.
Authenticated non-teachers are rewritten to `/forbidden` (HTTP 403).

## Troubleshooting

### "Error 400: redirect_uri_mismatch"

The redirect URI registered in Google Console does not match what Auth.js sent.
Check that the URI for the current tier (local / preview / production) is listed
in the **Authorized redirect URIs** in Google Console. The URI must be exact,
including scheme and path.

### Teacher can sign in but lands on the 403 page

1. Check `TEACHER_EMAILS` contains their email (exact match, case-insensitive).
2. Verify the Vercel deployment after the last env-var change — the new value is
   not live until the next deploy.
3. Confirm their row in `identity.user_account` has `role = 'teacher'`: 
   ```sql
   SELECT id, role FROM identity.user_account WHERE email = 'their@email.com';
   ```
   If the role is still `guardian`, have them sign out and sign in again — the
   `signIn` callback promotes the role on each login.

### Cookie not persisting across requests

`AUTH_SECRET` must be identical across all instances / functions for the same
deployment. In Vercel this is automatically consistent if set as a project-level
env var. If running multiple local servers, make sure `.env.local` is shared.

### Consent not carried over from before sign-in

The cookie-claim flow (D7) runs once per unclaimed learner ref. If the cookie
was cleared before sign-in, the learner ref is gone and there is nothing to
claim. Consent from `app.learner_consent_cache` is only migrated if the cookie
was still present at sign-in time.
