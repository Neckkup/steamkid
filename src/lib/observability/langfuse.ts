import { Langfuse } from "langfuse";

import { env, isLangfuseConfigured, langfuseEnvironment } from "@/lib/env";
import { pickAllowed, redactDeep } from "@/lib/privacy/redact";

/**
 * The only supported way to reach Langfuse.
 *
 * Two rules are enforced here rather than left to each caller:
 *
 * 1. Every AI call is traced. `traceAiCall` wraps the call; a feature that
 *    invokes an LLM outside this helper is considered unfinished.
 * 2. Nothing identifying leaves our infrastructure. Trace input/output go
 *    through the redaction layer, and the trace `userId` is a pseudonymous
 *    learner id, never an email, a name, or an auth subject.
 */

let client: Langfuse | null = null;

export function getLangfuse(): Langfuse | null {
  if (!isLangfuseConfigured) return null;
  if (client) return client;
  client = new Langfuse({
    publicKey: env.LANGFUSE_PUBLIC_KEY!,
    secretKey: env.LANGFUSE_SECRET_KEY!,
    baseUrl: env.LANGFUSE_BASEURL,
    // Every trace carries the tier so preview noise never pollutes production
    // dashboards or the eventual training-data selection queries.
    release: env.APP_ENV,
    // Langfuse's first-class environment separation: every trace, observation
    // and score is tagged, and the UI/API filter on it. `release` alone is a
    // free-text label — this is the field dashboards and alerts scope to, so a
    // developer's experiment can never move a production cost chart.
    environment: langfuseEnvironment,
    // Last line of defence. `traceAiCall` already redacts what it builds, but
    // `mask` runs over the input/output of *every* event the SDK ships,
    // including generations and spans a feature attaches itself. Someone adding
    // an observation without reading this file still cannot leak a raw email.
    mask: ({ data }) => redactDeep(data),
  });
  return client;
}

/**
 * Link to a trace in the Langfuse UI. Put this in logs and issue comments —
 * "the grading was wrong" is only debuggable if anyone can open the exact call.
 */
export function traceUrl(traceId: string | null): string | null {
  if (!traceId || !env.LANGFUSE_BASEURL) return null;
  return `${env.LANGFUSE_BASEURL.replace(/\/$/, "")}/trace/${traceId}`;
}

/**
 * Metadata we allow onto an external trace. Anything not on this list is
 * dropped before the payload is built — allow-list, not deny-list.
 */
export const ALLOWED_TRACE_METADATA_KEYS = [
  "lessonId",
  "exerciseId",
  "skillId",
  "submissionId",
  "attemptNumber",
  "gradeVersion",
  "promptName",
  "promptVersion",
  "model",
  "locale",
  "gradeLevel",
  // Added in PRO-5. `feature` is the coarse grouping every cost/latency
  // dashboard slices by (grading vs feedback vs learning-path), `promptLabel`
  // records which Langfuse label resolved (`production` / `latest`), and
  // `promptSource` says whether the prompt came from Langfuse or from the
  // in-repo fallback — a run served by the fallback is not a run you can
  // attribute to a prompt version.
  "feature",
  "promptLabel",
  "promptSource",
] as const;

export type TraceMetadata = Partial<
  Record<(typeof ALLOWED_TRACE_METADATA_KEYS)[number], unknown>
>;

export interface AiCallOptions {
  /** Trace name, e.g. `grade.short-answer`. Keep it stable — dashboards group on it. */
  name: string;
  /**
   * Pseudonymous learner id (the `learner_id` surrogate key, not a user email,
   * not an auth provider subject). This is what makes per-child debugging
   * possible without shipping a child's identity to a vendor.
   */
  learnerRef?: string;
  metadata?: TraceMetadata;
  /**
   * Model input. Redacted before it is sent. For a child's free-text answer,
   * pass `referenceOnly("submission", id)` instead of the raw text.
   */
  input?: unknown;
  tags?: string[];
}

export interface AiCallResult<T> {
  output: T;
  /** Optional token/cost usage to attach to the generation. */
  usage?: { input?: number; output?: number; total?: number };
}

/**
 * Wrap an AI call so it always produces a Langfuse trace.
 *
 * When Langfuse is unconfigured (bare local checkout) the call still runs, but
 * `assertObservabilityReady()` in `src/lib/env.ts` makes that impossible in
 * preview and production.
 */
export async function traceAiCall<T>(
  options: AiCallOptions,
  fn: (ctx: { traceId: string | null }) => Promise<AiCallResult<T>>,
): Promise<T> {
  const langfuse = getLangfuse();

  if (!langfuse) {
    const result = await fn({ traceId: null });
    return result.output;
  }

  const trace = langfuse.trace({
    name: options.name,
    userId: options.learnerRef,
    tags: options.tags,
    metadata: options.metadata
      ? pickAllowed(options.metadata as Record<string, unknown>, ALLOWED_TRACE_METADATA_KEYS)
      : undefined,
    input: options.input === undefined ? undefined : redactDeep(options.input),
  });

  const startedAt = Date.now();
  try {
    const result = await fn({ traceId: trace.id });
    trace.update({
      output: redactDeep(result.output),
      metadata: { durationMs: Date.now() - startedAt, usage: result.usage ?? null },
    });
    return result.output;
  } catch (error) {
    // A trace body has no status field; failures are recorded as a redacted
    // error output plus a tag so dashboards can filter on them.
    trace.update({
      output: {
        error: error instanceof Error ? redactDeep(error.message) : "unknown error",
      },
      tags: [...(options.tags ?? []), "error"],
      metadata: { durationMs: Date.now() - startedAt, failed: true },
    });
    throw error;
  } finally {
    // Serverless functions freeze immediately after the response, so the
    // background flush queue must be drained before we return.
    await langfuse.flushAsync().catch(() => undefined);
  }
}
