import { Langfuse } from "langfuse";

import { env, isLangfuseConfigured } from "@/lib/env";
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
  });
  return client;
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
