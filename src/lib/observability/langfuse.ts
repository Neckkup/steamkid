import { Langfuse } from "langfuse";

import { env, isLangfuseConfigured, langfuseEnvironment } from "@/lib/env";
import { UUID_PATTERN } from "@/lib/events/payload-schema";
import {
  resolveTraceDestination,
  type TraceAudience,
} from "@/lib/observability/trace-destination";
import { pickAllowed, redactDeep } from "@/lib/privacy/redact";

/**
 * The only supported way to reach Langfuse.
 *
 * Three rules are enforced here rather than left to each caller:
 *
 * 1. Every AI call is traced. `traceAiCall` wraps the call; a feature that
 *    invokes an LLM outside this helper is considered unfinished.
 * 2. Nothing identifying leaves our infrastructure. Trace input/output go
 *    through the redaction layer, and the trace `userId` is a pseudonymous
 *    learner id, never an email, a name, or an auth subject.
 * 3. A trace bound to a real learner only goes to an instance proven hardened.
 *    See `trace-destination.ts`; the gate is applied in `traceAiCall` below.
 */

let client: Langfuse | null = null;

export function getLangfuse(): Langfuse | null {
  if (!isLangfuseConfigured) return null;
  if (client) return client;

  // `isLangfuseConfigured` already covers this. Asserted again, here, because
  // this is the single line in the codebase where an undefined base URL stops
  // being a config gap and becomes an egress decision: `new Langfuse({ baseUrl:
  // undefined })` does not throw and does not disable itself, it points at
  // `https://cloud.langfuse.com`. Anyone who later loosens the predicate above
  // for a good-looking reason should hit this instead of shipping a child's
  // trace to a vendor.
  const baseUrl = env.LANGFUSE_BASEURL;
  if (!baseUrl) {
    throw new Error(
      "Refusing to construct a Langfuse client without an explicit baseUrl: the " +
        "SDK would fall back to cloud.langfuse.com. Set LANGFUSE_BASEURL to our " +
        "self-hosted instance (docs/adr/0002-observability-and-privacy.md).",
    );
  }

  client = new Langfuse({
    publicKey: env.LANGFUSE_PUBLIC_KEY!,
    secretKey: env.LANGFUSE_SECRET_KEY!,
    baseUrl,
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
   * **The client-minted `correlation_id`, used verbatim as the Langfuse trace id.**
   *
   * `data-schema` §5 forbids a Langfuse-generated trace id and states the
   * obligation as an equality: `app.ai_verdict.langfuse_trace_id ==
   * correlation_id`. The database says the same thing as a CHECK
   * (`ai_verdict_trace_is_correlation`), so a Langfuse-assigned id does not
   * produce a slightly-worse trace — it produces a verdict row Postgres
   * refuses.
   *
   * The id is minted by the browser before the action that leads to the call
   * and travels on the behaviour events (`events.behavior_event.correlation_id`),
   * which is what makes "what did the child do in the minute before the AI
   * graded this" a single-key join instead of a timestamp guess.
   */
  correlationId?: string;
  /**
   * `events.session.id` — sent as the Langfuse `sessionId`.
   *
   * Groups every AI call a child met in one sitting into one Langfuse session
   * view, which is the view you actually want open when asking why a lesson
   * went badly: the grading, the feedback and the path choice in order, not
   * three traces found separately by timestamp.
   */
  sessionId?: string;
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
  /**
   * Override the learner/synthetic classification the hardening gate keys off.
   *
   * Leave it unset in product code: a trace carrying `learnerRef`, `sessionId`
   * or `metadata.submissionId` is treated as a real child's by default, and
   * that default is the safe one. Set `"synthetic"` only where the binding
   * fields are fabricated — `scripts/ai-smoke.ts` mints a fake learner ref and
   * a fake session so the canary exercises the real shape of a call. The claim
   * is recorded on the trace as a `synthetic` tag, so it is visible in Langfuse
   * and not only in the source. See `trace-destination.ts`.
   */
  audience?: TraceAudience;
}

/**
 * The *same* pattern the ingest gate applies to `correlation_id` and
 * `session_id`, not a second opinion about what a UUID looks like: these two
 * ends have to agree about one value that was minted in a third place.
 *
 * Lowercase-only matters even though Postgres is case-insensitive about
 * `uuid`. An id that reaches Langfuse as `A1B2…` and is stored as `a1b2…` is
 * one value in two spellings, and anything comparing them as strings — a trace
 * URL, a dashboard filter, a join written in a notebook rather than in SQL —
 * quietly finds nothing.
 */
const CANONICAL_UUID = new RegExp(UUID_PATTERN);

/**
 * A call that cannot be identified the way `data-schema` §5 requires.
 *
 * Its own type so a caller can tell a wiring mistake apart from a model or
 * transport failure — this one is never worth retrying.
 */
export class TraceIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TraceIdentityError";
  }
}

/**
 * Resolve the two identifying fields, or refuse the call.
 *
 * **This throws in every environment, unlike the metadata allow-list, and the
 * difference is deliberate.** A dropped metadata key costs a dashboard column;
 * a wrong trace id costs the verdict itself — `ai_verdict.langfuse_trace_id`
 * is a `uuid NOT NULL` with a CHECK that it equals `correlation_id`, so a call
 * made without a usable id produces a result that cannot be stored at all.
 * Failing here is also the cheap moment to fail: it happens before the model
 * request, so nothing is half-done and no tokens are spent.
 *
 * The rule is "required as soon as the call is bound to a child". A call with a
 * `learnerRef` is a call whose verdict gets written and later joined back to
 * that child's behaviour; a call without one (a dataset run, an eval, a
 * warm-up) has nothing to join to and keeps working unchanged.
 *
 * `sessionId` stays optional even with a `learnerRef`: grading replayed from a
 * dataset or a backfill legitimately has no `events.session` row behind it, and
 * inventing one to satisfy a check would be worse than leaving the field empty.
 */
export function resolveTraceIdentity(options: AiCallOptions): {
  correlationId?: string;
  sessionId?: string;
} {
  const { correlationId, sessionId, learnerRef, name } = options;

  if (correlationId === undefined && learnerRef !== undefined) {
    throw new TraceIdentityError(
      `traceAiCall(${name}) has a learnerRef but no correlationId. A call bound to ` +
        `a child must carry the client-minted correlation_id: data-schema §5 makes ` +
        `it the trace id, and app.ai_verdict CHECKs that the two are equal.`,
    );
  }

  if (correlationId !== undefined && !CANONICAL_UUID.test(correlationId)) {
    throw new TraceIdentityError(
      `traceAiCall(${name}) got a correlationId that is not a lowercase UUID: ` +
        `${JSON.stringify(correlationId)}. It is sent to Langfuse as the trace id ` +
        `verbatim, so an off-format value does not fail — it produces a trace that ` +
        `no longer matches the correlation_id on the events or the verdict row.`,
    );
  }

  if (sessionId !== undefined && !CANONICAL_UUID.test(sessionId)) {
    throw new TraceIdentityError(
      `traceAiCall(${name}) got a sessionId that is not a lowercase UUID: ` +
        `${JSON.stringify(sessionId)}. It must be events.session.id, or the ` +
        `Langfuse session view groups traces under an id no table contains.`,
    );
  }

  return { correlationId, sessionId };
}

export interface AiCallResult<T> {
  output: T;
  /** Optional token/cost usage to attach to the generation. */
  usage?: { input?: number; output?: number; total?: number };
}

/**
 * Everything the wrapped call needs in order to attach to *this* trace.
 *
 * `langfuse` is handed down rather than re-fetched with `getLangfuse()` because
 * the hardening gate lives one level up: a callback that reached for the client
 * itself could still attach a generation — carrying the correlation id, the
 * prompt name, and the metadata — to an instance this trace was just refused
 * by. Null here means "this call is not being observed", and every observation
 * a feature wants to add hangs off this one handle.
 */
export interface AiCallContext {
  traceId: string | null;
  langfuse: Langfuse | null;
}

/**
 * Wrap an AI call so it always produces a Langfuse trace.
 *
 * When Langfuse is unconfigured (bare local checkout) the call still runs, but
 * `assertObservabilityReady()` in `src/lib/env.ts` makes that impossible in
 * preview and production.
 *
 * The same is true when the hardening gate refuses the destination: the child
 * still gets graded, and the trace is dropped with a logged reason. That
 * direction is deliberate. Losing a trace costs us a debugging session; sending
 * a learner-bound trace to an instance anyone can register an account on costs
 * a child an identifier we can never call back.
 */
export async function traceAiCall<T>(
  options: AiCallOptions,
  fn: (ctx: AiCallContext) => Promise<AiCallResult<T>>,
): Promise<T> {
  // Before the model call and before the Langfuse check, so a bare local
  // checkout catches a mis-wired call at the same moment production would.
  const identity = resolveTraceIdentity(options);
  const langfuse = getLangfuse();

  if (!langfuse) {
    // Still the caller's id, not null: there is only ever one id for this call,
    // and handing it back lets an unconfigured local checkout write an
    // ai_verdict row that satisfies the CHECK. The trace it names does not
    // exist yet — `assertObservabilityReady()` is what keeps that a local-only
    // state.
    const result = await fn({ traceId: identity.correlationId ?? null, langfuse: null });
    return result.output;
  }

  // The gate. Only reached once the destination is actually configured, and
  // cached inside `resolveTraceDestination`, so this is not a network round
  // trip per graded item.
  const destination = await resolveTraceDestination(options);
  if (!destination.allowed) {
    console.warn(
      `[langfuse] suppressed ${options.audience ?? "learner"} trace ${options.name}` +
        `${identity.correlationId ? ` (${identity.correlationId})` : ""}: ${destination.reason}`,
    );
    return (await fn({ traceId: identity.correlationId ?? null, langfuse: null })).output;
  }

  // A declared-synthetic trace says so in the data too, not just in the source,
  // so "which of these traces belong to a child" is answerable in the Langfuse
  // UI by anyone auditing the instance.
  const tags =
    destination.audience === "synthetic" && options.audience === "synthetic"
      ? [...new Set([...(options.tags ?? []), "synthetic"])]
      : options.tags;

  const trace = langfuse.trace({
    // Passing `id` is what makes Langfuse adopt our id instead of minting its
    // own. Read the id back from `trace.id` below all the same, so there is one
    // source of truth for what the SDK actually used.
    id: identity.correlationId,
    sessionId: identity.sessionId,
    name: options.name,
    userId: options.learnerRef,
    tags,
    metadata: options.metadata ? allowedTraceMetadata(options.metadata) : undefined,
    input: options.input === undefined ? undefined : redactDeep(options.input),
  });

  const startedAt = Date.now();
  try {
    const result = await fn({ traceId: trace.id, langfuse });
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
      tags: [...(tags ?? []), "error"],
      metadata: { durationMs: Date.now() - startedAt, failed: true },
    });
    throw error;
  } finally {
    // Serverless functions freeze immediately after the response, so the
    // background flush queue must be drained before we return.
    await langfuse.flushAsync().catch(() => undefined);
  }
}
