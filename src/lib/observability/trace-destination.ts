import { env } from "@/lib/env";
import {
  checkLangfuseHardening,
  type HardeningCheckId,
  type HardeningFinding,
  type LangfuseHardeningReport,
} from "@/lib/observability/langfuse-hardening";
import {
  checkCredentialsInUse,
  checkLeakedCredentialsRevoked,
} from "@/lib/observability/leaked-credentials";

/**
 * The runtime gate between a real learner's trace and an unhardened Langfuse.
 *
 * `langfuse-hardening.ts` can already tell whether an instance is safe to hold a
 * child's answer. Until this file existed, the only caller was
 * `scripts/langfuse-verify.ts` — a script someone has to remember to run. That
 * made the gate procedural, and a procedural gate is the wrong shape for this
 * particular risk: an identifier that leaves our infrastructure has left it
 * permanently, so the control has to be in the path the data takes, not in a
 * checklist beside it.
 *
 * Three rules shape everything below.
 *
 * 1. **Fail closed, including on "don't know".** `checkLangfuseHardening`
 *    reports `reachable: false` separately from `ok: false` precisely because
 *    the dangerous case is the inconclusive one — on 2026-09-22 the instance
 *    vanished, answered 404 on every path, and the signup probe read that 404
 *    as the strongest possible pass. Unverified is not clean. A probe that
 *    throws is treated the same way.
 * 2. **Block the data, not the development.** The gate keys off whether the
 *    trace carries a real learner binding, not off the deployment tier. Dataset
 *    runs, evals and smoke calls keep flowing against any instance; a trace
 *    that names a child does not.
 * 3. **Never silent.** A suppressed trace logs the failing check ids and the
 *    remedy. Observability that disappears without a word is worse than none.
 *
 * A hardened instance is necessary and not sufficient, so the same gate also
 * carries the findings from `leaked-credentials.ts`: a locked front door does
 * not help while a published key still opens it (PRO-101).
 */

export type TraceAudience = "learner" | "synthetic";

/**
 * What makes a trace "a real learner's".
 *
 * Any one of these binds the trace to a row about a child, so any one of them
 * is enough to require a hardened destination:
 *
 * - `learnerRef` is `app.learner.public_ref`, the one identifier `data-schema`
 *   decision 2 allows to leave our infrastructure.
 * - `sessionId` is `events.session.id` — a real sitting by a real child, and
 *   the join key from a trace back to their behaviour events.
 * - `metadata.submissionId` is `app.submission.id`, i.e. a child's work.
 *
 * `audience: "synthetic"` overrides the inference, for ops callers that carry
 * these fields without a child behind them — `scripts/ai-smoke.ts` mints a fake
 * learner ref and a fake session on purpose, because a canary that skipped the
 * identifying fields would stop proving the thing it exists to prove.
 *
 * **The claim is ignored on the production tier.** There is no such thing as a
 * synthetic child in production, so a `learnerRef` there is a real one and no
 * declaration in code can talk the gate out of it. That keeps the override a
 * development affordance rather than a hole a product call could fall into.
 */
export interface TraceAudienceSignals {
  learnerRef?: string;
  sessionId?: string;
  metadata?: { submissionId?: string };
  audience?: TraceAudience;
}

export function classifyTraceAudience(signals: TraceAudienceSignals): TraceAudience {
  const learnerBound =
    signals.learnerRef !== undefined ||
    signals.sessionId !== undefined ||
    signals.metadata?.submissionId !== undefined;

  if (!learnerBound) return "synthetic";
  if (signals.audience === "synthetic" && env.APP_ENV !== "production") return "synthetic";
  return "learner";
}

export interface TraceDestinationDecision {
  /** May this trace be sent to the configured instance? */
  allowed: boolean;
  audience: TraceAudience;
  /** Operator-facing explanation. Never contains a key or a credential. */
  reason: string;
  /** Hardening checks that failed, when a failure is what blocked the trace. */
  blockedBy: HardeningCheckId[];
  /** What to change, when there is something to change. */
  remedy: string | null;
}

export interface TraceDestinationOptions {
  baseUrl?: string;
  /** Injected in tests; defaults to the real hardening probe. */
  checkImpl?: typeof checkLangfuseHardening;
  /** Injected in tests; defaults to the real leaked-credential checks. */
  credentialsImpl?: CredentialCheckImpl;
}

export type CredentialCheckImpl = (baseUrl: string) => Promise<HardeningFinding[]>;

/**
 * Whether a credential we published is still a credential.
 *
 * Runs against the same base URL and inside the same cached verdict as the
 * hardening probe, so a leaked key that still opens the project costs one probe
 * per `PASS_TTL_MS` rather than one per graded answer.
 */
const credentialChecks: CredentialCheckImpl = (baseUrl) =>
  Promise.all([
    checkCredentialsInUse({
      langfusePublicKey: env.LANGFUSE_PUBLIC_KEY,
      langfuseSecretKey: env.LANGFUSE_SECRET_KEY,
      geminiApiKey: env.GEMINI_API_KEY,
    }),
    checkLeakedCredentialsRevoked({
      baseUrl,
      revoked: {
        publicKey: env.LANGFUSE_REVOKED_PUBLIC_KEY,
        secretKey: env.LANGFUSE_REVOKED_SECRET_KEY,
      },
      control: {
        publicKey: env.LANGFUSE_PUBLIC_KEY,
        secretKey: env.LANGFUSE_SECRET_KEY,
      },
      timeoutMs: PROBE_TIMEOUT_MS,
    }),
  ]);

/**
 * Shorter than the probe's own 10s default: this sits in front of a child's
 * grading call on a cache miss, and a slow answer is not worth a slow lesson.
 * Timing out fails closed, so the cost of being impatient is a dropped trace,
 * never a trace that lands somewhere it should not.
 */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * A pass is cached longer than a failure, deliberately asymmetric.
 *
 * A stale pass is bounded exposure — at most this long after someone reopens
 * registration. A stale failure is an outage of our own observability that
 * outlives the fix, so it expires fast enough that clearing the finding brings
 * traces back within about a minute without anyone redeploying.
 */
const PASS_TTL_MS = 5 * 60_000;
const FAIL_TTL_MS = 60_000;

interface GateEntry {
  key: string;
  expiresAt: number;
  report: LangfuseHardeningReport;
}

let entry: GateEntry | null = null;
let inFlight: { key: string; promise: Promise<LangfuseHardeningReport> } | null = null;

/**
 * The cache is module scope and nothing else, on purpose.
 *
 * A verdict about a specific instance at a specific moment must not outlive the
 * code that recorded it, so it lives in process memory that a deploy discards,
 * never in Redis, a file, or any store that survives a release. The build
 * identity is folded into the key as a second line of defence for runtimes that
 * reuse a warm process across releases, and the base URL is in the key because
 * repointing `LANGFUSE_BASEURL` is repointing the destination.
 */
function gateKey(baseUrl: string): string {
  const build =
    process.env.VERCEL_DEPLOYMENT_ID ??
    process.env.VERCEL_GIT_COMMIT_SHA ??
    process.env.GIT_COMMIT_SHA ??
    process.env.SOURCE_VERSION ??
    "unknown-build";
  return `${baseUrl}@${build}`;
}

/** Drop the cached verdict. Tests use this; product code never needs it. */
export function resetTraceDestinationCache(): void {
  entry = null;
  inFlight = null;
}

/**
 * The verdict that a probe could not produce.
 *
 * Written out rather than reusing the probe's own "not configured" return so
 * that a thrown fetch, an aborted timeout and a missing base URL all land on
 * the same unambiguous shape: unreachable, therefore unverified.
 */
const UNVERIFIED: LangfuseHardeningReport = { ok: false, reachable: false, findings: [] };

async function hardeningReport(
  baseUrl: string,
  checkImpl: typeof checkLangfuseHardening,
  credentialsImpl: CredentialCheckImpl,
): Promise<LangfuseHardeningReport> {
  const key = gateKey(baseUrl);
  const now = Date.now();

  if (entry && entry.key === key && entry.expiresAt > now) return entry.report;
  if (inFlight && inFlight.key === key) return inFlight.promise;

  const promise = (async () => {
    let report: LangfuseHardeningReport;
    try {
      report = await checkImpl({ baseUrl, timeoutMs: PROBE_TIMEOUT_MS });
    } catch (error) {
      // A probe that throws has told us nothing, and "nothing" is not a pass.
      console.error(
        `[langfuse] hardening probe of ${baseUrl} failed to run (${
          error instanceof Error ? error.message : "unknown error"
        }). Treating the instance as unverified: real learner traces will be ` +
          `suppressed until it answers.`,
      );
      report = UNVERIFIED;
    }

    // Only worth asking who else holds a key to this instance once the instance
    // has answered at all. An unreachable one is already blocked, and probing a
    // host that is not there produces a second inconclusive answer, not a
    // second reason.
    if (report.reachable) {
      let credentials: HardeningFinding[];
      try {
        credentials = await credentialsImpl(baseUrl);
      } catch (error) {
        console.error(
          `[langfuse] leaked-credential check against ${baseUrl} failed to run (${
            error instanceof Error ? error.message : "unknown error"
          }). Treating the published pair as still live: real learner traces will ` +
            `be suppressed until it answers.`,
        );
        credentials = [
          {
            id: "leaked_credentials_live",
            ok: false,
            severity: "blocker",
            reason:
              "The check that proves the 2026-09-19 leaked pair is dead could not " +
              "run, so nothing here says it is.",
            remedy: "Re-run `npm run langfuse:verify` once the instance answers normally.",
          },
        ];
      }
      const findings = [...report.findings, ...credentials];
      report = {
        reachable: report.reachable,
        findings,
        ok: findings.every((finding) => finding.ok),
      };
    }

    const passed = report.ok && report.reachable;
    entry = {
      key,
      expiresAt: Date.now() + (passed ? PASS_TTL_MS : FAIL_TTL_MS),
      report,
    };
    logFreshVerdict(baseUrl, report);
    return report;
  })();

  inFlight = { key, promise };
  void promise.finally(() => {
    if (inFlight?.promise === promise) inFlight = null;
  });

  return promise;
}

/**
 * Log once per probe, not once per trace.
 *
 * The detail an operator needs — which check failed and how to clear it —
 * belongs with the decision that was actually computed. `traceAiCall` adds a
 * short line per suppressed trace so an individual dropped call is still
 * visible; repeating the full report there would bury it.
 */
function logFreshVerdict(baseUrl: string, report: LangfuseHardeningReport): void {
  if (report.ok && report.reachable) return;

  if (!report.reachable) {
    console.error(
      `[langfuse] ${baseUrl} could not be verified as hardened` +
        `${report.findings[0] ? `: ${report.findings[0].reason}` : "; no check reached a conclusion"}. ` +
        `Real learner traces are suppressed. An unverified instance is not a clean one.`,
    );
    return;
  }

  for (const finding of report.findings) {
    if (finding.ok) continue;
    console.error(
      `[langfuse] hardening finding ${finding.id} (${finding.severity}) on ${baseUrl}: ` +
        `${finding.reason}\n     fix: ${finding.remedy}`,
    );
  }
}

/**
 * Decide whether this trace may be sent to the configured Langfuse.
 *
 * Only `severity: "blocker"` findings stop a trace. Severity is declared at the
 * finding for exactly this reason — a `warning` is defined as something not on
 * the path between a child's answer and an attacker, and a future warning-level
 * check must not be able to switch off our observability by existing.
 */
export async function resolveTraceDestination(
  signals: TraceAudienceSignals,
  options: TraceDestinationOptions = {},
): Promise<TraceDestinationDecision> {
  const audience = classifyTraceAudience(signals);

  if (audience === "synthetic") {
    return {
      allowed: true,
      audience,
      reason:
        "No learner binding on this trace, so nothing about a child can land on " +
        "the instance. Development and eval runs are not what this gate exists to stop.",
      blockedBy: [],
      remedy: null,
    };
  }

  const baseUrl = (options.baseUrl ?? env.LANGFUSE_BASEURL)?.trim();
  if (!baseUrl) {
    return {
      allowed: false,
      audience,
      reason:
        "No LANGFUSE_BASEURL is configured, so the destination of this trace is " +
        "unknown and cannot be verified.",
      blockedBy: [],
      remedy: "Set LANGFUSE_BASEURL to our self-hosted instance.",
    };
  }

  const report = await hardeningReport(
    baseUrl,
    options.checkImpl ?? checkLangfuseHardening,
    options.credentialsImpl ?? credentialChecks,
  );

  if (!report.reachable) {
    return {
      allowed: false,
      audience,
      reason:
        `${baseUrl} could not be verified as hardened — no hardening check reached ` +
        `a conclusion. An instance we cannot check is unverified, not clean, so this ` +
        `learner trace is not sent.`,
      blockedBy: report.findings.map((finding) => finding.id),
      remedy:
        report.findings.find((finding) => !finding.ok)?.remedy ??
        "Bring the instance back up, then re-run `npm run langfuse:verify`.",
    };
  }

  const blockers = report.findings.filter(
    (finding) => !finding.ok && finding.severity === "blocker",
  );

  if (blockers.length > 0) {
    return {
      allowed: false,
      audience,
      reason:
        `${baseUrl} is not cleared to hold a real learner's trace ` +
        `(${blockers.map((finding) => finding.id).join(", ")}), so this one is not sent to it.`,
      blockedBy: blockers.map((finding) => finding.id),
      remedy: blockers[0].remedy,
    };
  }

  return {
    allowed: true,
    audience,
    reason: `${baseUrl} passed every hardening check that reached a conclusion.`,
    blockedBy: [],
    remedy: null,
  };
}
