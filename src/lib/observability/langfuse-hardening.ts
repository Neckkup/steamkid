/**
 * Post-provisioning hardening checks for a self-hosted Langfuse.
 *
 * `langfuse-version.ts` answers "is this instance capable of what we designed".
 * This file answers the other question that is invisible from the ingest side:
 * "is this instance safe to put a child's free-text answer into".
 *
 * Both of the checks here caught a real defect on `langfuse.homekup.com` the
 * first time they were run, which is why they are code and not step 3 of a
 * runbook. A freshly provisioned Langfuse is healthy, serves HTTPS, passes the
 * v4 gate, and still ships with open registration — nothing about the happy
 * path tells you that.
 *
 * Everything here is unauthenticated on purpose: it has to work at provisioning
 * time, before an org, a project, or an API key exists.
 */

export type HardeningCheckId = "canonical_url_tls" | "open_signup";

export interface HardeningFinding {
  id: HardeningCheckId;
  ok: boolean;
  /**
   * `blocker` means: do not point a deployed tier at this instance and do not
   * let a real trace land in it. `warning` means: fix it, but it is not on the
   * path between a child's answer and an attacker.
   */
  severity: "blocker" | "warning";
  /** Operator-facing explanation. Never contains a key or a credential. */
  reason: string;
  /** The exact change that clears the finding. */
  remedy: string;
}

export interface LangfuseHardeningReport {
  ok: boolean;
  /** False when the instance did not answer at all; findings will be empty. */
  reachable: boolean;
  findings: HardeningFinding[];
}

export interface HardeningCheckOptions {
  baseUrl?: string;
  /** Injected in tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function normaliseBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, "");
}

/**
 * NextAuth derives cookie security from the deployment URL it is configured
 * with, not from the scheme the request arrived on. When `NEXTAUTH_URL` is
 * `http://…` behind a TLS-terminating proxy, the instance serves fine over
 * HTTPS while issuing session cookies without `Secure` and without the
 * `__Secure-` prefix. A single plaintext request to the domain — a typed URL, a
 * stale bookmark, an http link — then puts that session cookie on the wire
 * before the 301 to HTTPS can happen.
 *
 * `/api/auth/providers` echoes the configured URL back unauthenticated, so this
 * is readable from outside the box.
 */
async function checkCanonicalUrlTls(
  baseUrl: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<HardeningFinding | null> {
  const url = `${baseUrl}/api/auth/providers`;
  let payload: unknown;
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    payload = await response.json();
  } catch {
    return null;
  }

  if (typeof payload !== "object" || payload === null) return null;

  const urls: string[] = [];
  for (const provider of Object.values(payload as Record<string, unknown>)) {
    if (typeof provider !== "object" || provider === null) continue;
    for (const key of ["signinUrl", "callbackUrl"] as const) {
      const value = (provider as Record<string, unknown>)[key];
      if (typeof value === "string" && value !== "") urls.push(value);
    }
  }

  if (urls.length === 0) return null;

  const plaintext = urls.filter((value) => value.startsWith("http://"));
  const ok = plaintext.length === 0;

  return {
    id: "canonical_url_tls",
    ok,
    severity: "blocker",
    reason: ok
      ? "NEXTAUTH_URL is an https:// origin, so session cookies are issued Secure."
      : `NEXTAUTH_URL is a plaintext origin — ${url} advertises ${plaintext[0]}. ` +
        "NextAuth keys cookie security off this value, not off the scheme the " +
        "request arrived on, so session cookies are issued without Secure and " +
        "leak on the first plaintext request to the domain.",
    remedy:
      "Set NEXTAUTH_URL to the https:// origin in the compose .env and restart " +
      "langfuse-web. Existing sessions should be invalidated afterwards.",
  };
}

/**
 * Langfuse ships with registration open. On a public instance that means
 * anybody who finds the URL can create an account, and the only thing between
 * them and the traces is whether they can also get into an org.
 *
 * Probed by POSTing an empty body: the request is rejected either way, creates
 * nothing, and the *shape* of the rejection is the signal. A hardened instance
 * refuses on policy before it ever validates the body; an open one falls
 * through to schema validation and complains about the missing fields.
 */
async function checkOpenSignup(
  baseUrl: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<HardeningFinding | null> {
  const url = `${baseUrl}/api/auth/signup`;
  let status: number;
  let body: string;
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = response.status;
    body = await response.text();
  } catch {
    return null;
  }

  // 404 means the route is compiled out entirely — the strongest possible pass.
  if (status === 404) {
    return {
      id: "open_signup",
      ok: true,
      severity: "blocker",
      reason: "The signup route is not served at all.",
      remedy: "None needed.",
    };
  }

  const refusedOnPolicy = /sign[\s-]?up[^.]{0,40}disabled|disabled[^.]{0,40}sign[\s-]?up/i.test(
    body,
  );
  if (refusedOnPolicy) {
    return {
      id: "open_signup",
      ok: true,
      severity: "blocker",
      reason: "The instance refuses registration on policy (AUTH_DISABLE_SIGNUP is set).",
      remedy: "None needed.",
    };
  }

  return {
    id: "open_signup",
    ok: false,
    severity: "blocker",
    reason:
      `${url} accepted an anonymous registration attempt and rejected it only on ` +
      `schema validation (HTTP ${status}). Registration is open to the internet: ` +
      "anyone who finds this URL can create an account on the instance that holds " +
      "our traces.",
    remedy:
      "Set AUTH_DISABLE_SIGNUP=true in the compose .env and restart langfuse-web, " +
      "after the team's own accounts exist. Then audit the existing user list for " +
      "accounts nobody on the team recognises.",
  };
}

/**
 * Run every hardening check against a live instance.
 *
 * Fails closed on `not configured`, but *not* on an individual check that could
 * not reach a conclusion — a check that returns null is dropped rather than
 * counted as a pass or a failure, so a future Langfuse that moves an endpoint
 * degrades this into "checked less" instead of "blocked everything".
 */
export async function checkLangfuseHardening(
  options: HardeningCheckOptions = {},
): Promise<LangfuseHardeningReport> {
  const baseUrl = options.baseUrl?.trim();
  if (!baseUrl) {
    return {
      ok: false,
      reachable: false,
      findings: [],
    };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const normalised = normaliseBaseUrl(baseUrl);

  const findings = (
    await Promise.all([
      checkCanonicalUrlTls(normalised, fetchImpl, timeoutMs),
      checkOpenSignup(normalised, fetchImpl, timeoutMs),
    ])
  ).filter((finding): finding is HardeningFinding => finding !== null);

  // An instance we could not reach at all is not "clean" — it is unchecked.
  // `ok` therefore requires at least one check to have reached a conclusion.
  return {
    ok: findings.length > 0 && findings.every((finding) => finding.ok),
    reachable: findings.length > 0,
    findings,
  };
}
