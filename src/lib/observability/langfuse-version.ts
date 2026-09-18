/**
 * Guard against pointing this app at a Langfuse major version that cannot do
 * what we designed on top of it.
 *
 * Why this is code and not a sentence in a runbook: on the day we provisioned,
 * upstream was shipping BOTH lines — v4.38.0 and v3.225.8 came out within a day
 * of each other. "Pin a release tag" is therefore not enough guidance; an
 * operator who grabs a recent-looking tag can land on a v3 patch and get a
 * server that boots, accepts traces, and silently cannot do two things we
 * already committed to:
 *
 *   1. The six alerts specified in `docs/runbooks/ai-observability.md`.
 *      Self-hosted alerting exists only from v4, and we do not write our own.
 *   2. `GET /api/public/v2/metrics`, which every widget in `dashboards.ts`
 *      queries.
 *
 * Both failures are silent at ingest time and only surface as "why is nobody
 * being paged" weeks later, which is the worst possible time to find out.
 */

/** Below this, the observability design in ADR 0002 does not hold. */
export const MINIMUM_LANGFUSE_MAJOR = 4;

/**
 * The exact tag the runbook provisions. Verified against the upstream release
 * list on 2026-09-18. Bump deliberately — read the release notes for ClickHouse
 * migrations first, and snapshot before upgrading.
 */
export const PINNED_LANGFUSE_TAG = "v4.38.0";

export type LangfuseVersionStatus =
  | "ok"
  | "not_configured"
  | "unreachable"
  | "unparseable"
  | "too_old";

export interface LangfuseVersionCheck {
  ok: boolean;
  status: LangfuseVersionStatus;
  /** Version string the server reported, when we got one. */
  version: string | null;
  major: number | null;
  /** Operator-facing explanation. Never contains a key or a credential. */
  reason: string;
}

/**
 * Parse the major from a Langfuse `version` string (`"4.38.0"`, `"v4.38.0"`,
 * `"4.38.0-rc.1"`). Returns null for anything we cannot read with confidence —
 * an unreadable version is treated as a failure, not waved through.
 */
export function parseLangfuseMajor(version: string): number | null {
  const match = /^v?(\d+)\./.exec(version.trim());
  if (!match) return null;
  const major = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(major) ? major : null;
}

export interface CheckOptions {
  baseUrl?: string;
  /** Injected in tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Ask a running Langfuse what it is. `/api/public/health` is unauthenticated
 * and returns `{ status, version }`, so this works before any project or API
 * key exists — i.e. at provisioning time, which is when it matters.
 */
export async function checkLangfuseServerVersion(
  options: CheckOptions = {},
): Promise<LangfuseVersionCheck> {
  const baseUrl = options.baseUrl?.trim();
  if (!baseUrl) {
    return {
      ok: false,
      status: "not_configured",
      version: null,
      major: null,
      reason: "LANGFUSE_BASEURL is not set, so there is no instance to check.",
    };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${baseUrl.replace(/\/$/, "")}/api/public/health`;

  let payload: unknown;
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
    if (!response.ok) {
      return {
        ok: false,
        status: "unreachable",
        version: null,
        major: null,
        reason: `${url} returned HTTP ${response.status}.`,
      };
    }
    payload = await response.json();
  } catch (error) {
    return {
      ok: false,
      status: "unreachable",
      version: null,
      major: null,
      reason: `${url} could not be reached: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    };
  }

  const version =
    typeof payload === "object" && payload !== null && "version" in payload
      ? (payload as { version?: unknown }).version
      : undefined;

  if (typeof version !== "string" || version.trim() === "") {
    return {
      ok: false,
      status: "unparseable",
      version: null,
      major: null,
      reason: `${url} responded without a usable "version" field.`,
    };
  }

  const major = parseLangfuseMajor(version);
  if (major === null) {
    return {
      ok: false,
      status: "unparseable",
      version,
      major: null,
      reason: `Could not read a major version out of "${version}".`,
    };
  }

  if (major < MINIMUM_LANGFUSE_MAJOR) {
    return {
      ok: false,
      status: "too_old",
      version,
      major,
      reason:
        `Instance is Langfuse ${version}. We require v${MINIMUM_LANGFUSE_MAJOR} or newer: ` +
        "self-hosted alerting and GET /api/public/v2/metrics do not exist below it, " +
        `so the alerts and dashboards we already specified cannot be configured. ` +
        `Redeploy on ${PINNED_LANGFUSE_TAG}.`,
    };
  }

  return {
    ok: true,
    status: "ok",
    version,
    major,
    reason: `Langfuse ${version} satisfies the v${MINIMUM_LANGFUSE_MAJOR}+ requirement.`,
  };
}
