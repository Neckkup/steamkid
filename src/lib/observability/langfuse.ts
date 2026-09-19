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
 *
 * **Key naming: camelCase on this surface, deliberately** (PRO-15 item 3).
 *
 * `data-schema` §5 writes the mandatory fields as `rubric_version`,
 * `redaction_version`, `consent_scopes`, `grade_band`, because it is a SQL
 * document and SQL is snake_case. The event registry is snake_case for the same
 * reason — it is a JSON wire contract shared with the client.
 *
 * A Langfuse trace is a third surface with its own existing idiom: every native
 * dimension the UI offers next to our metadata in the same filter bar is
 * camelCase (`promptName`, `promptVersion`, `providedModelName`, `traceName` —
 * see `OBSERVATION_DIMENSIONS` in `dashboards.ts`). Writing `prompt_name` into
 * metadata would put it one row below Langfuse's own `promptName` in that
 * dropdown, which is the exact two-standards-in-one-trace confusion this rule
 * exists to prevent.
 *
 * So the rule is **one convention per surface, applied without exception**:
 * Postgres snake_case, event wire snake_case, Langfuse camelCase. What the spec
 * mandates is the *facts*, not the casing; the mapping is one-to-one and
 * mechanical:
 *
 * | `data-schema` §5     | trace metadata key |
 * | -------------------- | ------------------ |
 * | `rubric_version`     | `rubricVersion`    |
 * | `redaction_version`  | `redactionVersion` |
 * | `consent_scopes`     | `consentScopes`    |
 * | `grade_band`         | `gradeBand`        |
 */
export const ALLOWED_TRACE_METADATA_KEYS = [
  // Mandated on every trace by `data-schema` §5. Added in PRO-15: they were
  // absent, and because this is an allow-list they were being dropped in
  // silence — a trace that looked fine and did not carry what the spec requires.
  "rubricVersion",
  "redactionVersion",
  "consentScopes",
  "gradeBand",

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

export type AllowedTraceMetadataKey = (typeof ALLOWED_TRACE_METADATA_KEYS)[number];

/** `app.learner.grade_band` — the only school-level detail allowed on a trace. */
export type GradeBand = "p4" | "p5" | "p6";

/**
 * Typed rather than `Record<string, unknown>` so the four spec-mandated fields
 * have a shape a caller cannot get subtly wrong — `consentScopes` in particular
 * is a list, and shipping it as a comma-joined string would make every
 * consent-scoped dashboard filter silently miss.
 */
export interface TraceMetadata {
  /** `app.rubric_version.version`, as `"{rubric_code}@{version}"`. */
  rubricVersion?: string;
  /** Version of the redaction layer that produced the trace input. */
  redactionVersion?: string;
  /** Consent scopes in force when the call was made, e.g. `["ai_grading"]`. */
  consentScopes?: string[];
  gradeBand?: GradeBand;

  lessonId?: string;
  exerciseId?: string;
  skillId?: string;
  submissionId?: string;
  attemptNumber?: number;
  gradeVersion?: string;
  promptName?: string;
  promptVersion?: number;
  model?: string;
  locale?: string;
  gradeLevel?: string;
  feature?: string;
  promptLabel?: string;
  promptSource?: string;
}

// Compile-time guard: the allow-list and the interface must describe exactly the
// same key set. Adding a field to one and forgetting the other is how a
// spec-mandated value starts being dropped in silence again.
type KeysMatch =
  [AllowedTraceMetadataKey] extends [keyof TraceMetadata]
    ? [keyof TraceMetadata] extends [AllowedTraceMetadataKey]
      ? true
      : never
    : never;
const _allowListMatchesInterface: KeysMatch = true;
void _allowListMatchesInterface;

/**
 * Apply the allow-list, and refuse to do it quietly.
 *
 * TypeScript already rejects an unknown key in an object *literal*, but
 * metadata assembled dynamically (spread from a request, built in a loop)
 * bypasses that and used to vanish without a sound. Locally that is now a
 * thrown error, so it surfaces while someone is writing the call; in a deployed
 * environment it is a warning, because dropping a metadata key is never a good
 * enough reason to fail a child's grading mid-request.
 */
export function allowedTraceMetadata(metadata: TraceMetadata): Record<string, unknown> {
  const dropped = Object.keys(metadata).filter(
    (key) => !(ALLOWED_TRACE_METADATA_KEYS as readonly string[]).includes(key),
  );

  if (dropped.length > 0) {
    const message =
      `Trace metadata dropped by the allow-list: ${dropped.join(", ")}. ` +
      `Add the key to ALLOWED_TRACE_METADATA_KEYS (and TraceMetadata) if it is ` +
      `safe to send to an external service, or stop passing it.`;
    if (env.APP_ENV === "local") throw new Error(message);
    console.warn(message);
  }

  return pickAllowed(metadata as Record<string, unknown>, ALLOWED_TRACE_METADATA_KEYS);
}

export interface AiCallOptions {
  /** Trace name, e.g. `grade.short-answer`. Keep it stable — dashboards group on it. */
  name: string;
  /**
   * **`app.learner.public_ref` — never `app.learner.id`.**
   *
   * `data-schema` decision 2 makes `public_ref` the only identifier allowed to
   * leave our infrastructure, and names the primary key as the thing it must
   * not be. The reason is recovery: a `public_ref` that ends up somewhere we
   * regret can be rotated on its own, while the PK is wired into every foreign
   * key in the database and cannot be. An id that has left the building cannot
   * be called back, so this is a one-way mistake.
   *
   * Sent as the Langfuse `userId`, which is what makes per-child debugging
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
    metadata: options.metadata ? allowedTraceMetadata(options.metadata) : undefined,
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
