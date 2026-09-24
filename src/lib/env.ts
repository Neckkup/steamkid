import { z } from "zod";

import { resolveMigrateUrl, resolveRuntimeUrl } from "@/lib/db/connection-env";

/**
 * Single source of truth for configuration.
 *
 * Rules for this file:
 * - Secrets are read from `process.env` only. Never hard-code a value here.
 * - Observability vars are optional so the app still boots in a bare local
 *   checkout, but `assertObservabilityReady()` fails the deployed environments
 *   that must have them (see `src/lib/observability/langfuse.ts`).
 */
/**
 * Hosting platforms and CI commonly define a variable as an empty string rather
 * than leaving it unset. Treat `""` as "not configured" so a blank placeholder
 * never fails the build or, worse, gets used as a real key.
 */
const blankAsUndefined = <T extends z.ZodType>(inner: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), inner.optional());

const schema = z.object({
  NODE_ENV: blankAsUndefined(z.enum(["development", "test", "production"])).transform(
    (value) => value ?? "development",
  ),

  /** Deployment tier. Drives how strict the observability checks are. */
  APP_ENV: blankAsUndefined(z.enum(["local", "preview", "production"])).transform(
    (value) => value ?? "local",
  ),

  /** Public base URL of the running deployment, used by auth callbacks. */
  APP_URL: blankAsUndefined(z.string().url()).transform(
    (value) => value ?? "http://localhost:3000",
  ),

  /**
   * Postgres connection string (pooled), role `steamkid_runtime`.
   *
   * `RUNTIME_DATABASE_URL` is the injected name and wins over this one; see
   * `src/lib/db/connection-env.ts` and `readEnv` below.
   */
  DATABASE_URL: blankAsUndefined(z.string().min(1)),
  /**
   * Direct (unpooled) Postgres connection string, used by migrations, role
   * `steamkid_migrate`. `MIGRATE_DATABASE_URL` is the injected name and wins.
   */
  DIRECT_URL: blankAsUndefined(z.string().min(1)),

  /** Auth.js session secret. */
  AUTH_SECRET: blankAsUndefined(z.string().min(1)),

  /**
   * Gemini API key (see `docs/adr/0004-llm-provider-gemini.md`). Server-side
   * only — never expose to the browser. Must belong to a **billing-enabled**
   * project: free-tier Gemini traffic is used to improve Google products, and a
   * child's answer is not training data for anyone but us.
   */
  GEMINI_API_KEY: blankAsUndefined(z.string().min(1)),

  /**
   * Langfuse. `LANGFUSE_BASEURL` points at our self-hosted instance.
   *
   * **It is not an optional nicety, it is the destination.** The Langfuse SDK
   * falls back to `https://cloud.langfuse.com` when no `baseUrl` is passed, so
   * an unset value here does not disable tracing — it redirects every trace we
   * produce to a US SaaS we deliberately rejected in
   * `docs/adr/0002-observability-and-privacy.md`. That is why
   * `isLangfuseConfigured` below requires all three values and not just the
   * keys: "no base URL" must mean "do not trace", never "trace somewhere else".
   *
   * `LANGFUSE_BASE_URL` is accepted as an alias (see `readEnv`).
   */
  LANGFUSE_PUBLIC_KEY: blankAsUndefined(z.string().min(1)),
  LANGFUSE_SECRET_KEY: blankAsUndefined(z.string().min(1)),
  LANGFUSE_BASEURL: blankAsUndefined(z.string().url()),

  /**
   * The Langfuse key pair that was published in clear text on PRO-30 on
   * 2026-09-19 — supplied here **so that it can be proven dead**, not so that it
   * can be used. `leaked-credentials.ts` probes with it and refuses to send a
   * real learner's trace until the instance answers 401.
   *
   * Counter-intuitive but deliberate: the credential we need in order to verify
   * a revocation is precisely the compromised one. It is pinned by digest at the
   * check, so a different value cannot stand in for it, and it stays out of the
   * repo like every other key. Once the pair is deleted in Langfuse these can be
   * unset — the gate will already have passed on the 401 and the values are then
   * inert.
   */
  LANGFUSE_REVOKED_PUBLIC_KEY: blankAsUndefined(z.string().min(1)),
  LANGFUSE_REVOKED_SECRET_KEY: blankAsUndefined(z.string().min(1)),
  /**
   * Langfuse tracing environment. Normally derived from `APP_ENV`; override only
   * to carve out a sub-environment (e.g. `ci`, `load-test`) that must not land
   * in the same charts as real traffic. Langfuse requires lowercase
   * alphanumerics with `-`/`_`, and reserves the `langfuse` prefix.
   */
  LANGFUSE_TRACING_ENVIRONMENT: blankAsUndefined(
    z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]*$/, "must be lowercase alphanumeric with - or _")
      .refine((value) => !value.startsWith("langfuse"), {
        message: "the `langfuse` prefix is reserved by Langfuse",
      }),
  ),

  /** Sentry. The DSN is public by design; the auth token is not. */
  NEXT_PUBLIC_SENTRY_DSN: blankAsUndefined(z.string().min(1)),
  SENTRY_ORG: blankAsUndefined(z.string().min(1)),
  SENTRY_PROJECT: blankAsUndefined(z.string().min(1)),
  SENTRY_AUTH_TOKEN: blankAsUndefined(z.string().min(1)),

  /**
   * Kill switch for AI grading on a child's own request (PRO-115).
   *
   * `off` puts `/api/attempts` and `/api/submissions` back to the behaviour
   * they had before the grader was connected: the answer is still stored, the
   * child is still told their work arrived, and no model is called. It is an
   * environment variable rather than a code path so a bad prompt version or a
   * cost spike can be stopped without a deploy.
   *
   * Default `on`. Leaving it off by default would reproduce the thing PRO-115
   * was filed about — an engine wired to nothing — and the real gates on this
   * path are the ones that cannot be forgotten: guardian `ai_grading` consent,
   * an `app.learner` row, and a database to store the verdict in.
   */
  AI_GRADING_INLINE: blankAsUndefined(z.enum(["on", "off"])).transform((value) => value ?? "on"),

  /**
   * How long a child waits for the grader before the screen stops waiting.
   *
   * Not a cancellation: the call keeps running and its verdict is still stored
   * (see `gradeForRequest`), so the teacher queue and a later page load get it.
   * This is only the point at which making a ten-year-old stare at a spinner
   * stops being worth it. `docs/runbooks/ai-observability.md` warns at a p95 of
   * 15s and alerts at 30s, so a budget above 15s would mean the normal case is
   * already an alert.
   */
  AI_GRADING_BUDGET_MS: blankAsUndefined(z.coerce.number().int().min(1_000).max(30_000)).transform(
    (value) => value ?? 8_000,
  ),

  /**
   * Shared secret for internal cron endpoints (`/api/internal/*`).
   *
   * Set this in production. Internal endpoints check `Authorization: Bearer
   * <token>` against this value. In `APP_ENV=local` the check is skipped so
   * local dev can call the endpoints without setup.
   */
  INTERNAL_CRON_SECRET: blankAsUndefined(z.string().min(16)),
});

export type Env = z.infer<typeof schema>;

/**
 * The process environment, with the names we know drift folded in.
 *
 * ## The two Postgres roles
 *
 * `MIGRATE_DATABASE_URL` and `RUNTIME_DATABASE_URL` are the names the split
 * roles are injected under (PRO-103); `DIRECT_URL` and `DATABASE_URL` are the
 * names the rest of this codebase uses and the names a local checkout sets. The
 * new name wins, because after the cutover the old one still carries the
 * retiring combined `steamkid_app` credential — see
 * `src/lib/db/connection-env.ts` for why the binding could not simply be
 * replaced under the old name.
 *
 * ## Langfuse
 *
 * `LANGFUSE_BASEURL` (no underscore) is the name the Langfuse SDK itself uses
 * and the name every doc and script in this repo uses. Secret injection in our
 * runner supplies `LANGFUSE_BASE_URL`. Those are one value with two spellings,
 * and getting the spelling wrong is not a harmless typo here: with the keys
 * present and no base URL, the SDK silently targets `cloud.langfuse.com`.
 *
 * So accept both rather than let a one-character difference choose the
 * destination of a child's trace. `LANGFUSE_BASEURL` wins when both are set;
 * the alias is read only as a fallback.
 */
function readEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const baseUrl = source.LANGFUSE_BASEURL?.trim() || source.LANGFUSE_BASE_URL?.trim();
  const migrate = resolveMigrateUrl(source);
  const runtime = resolveRuntimeUrl(source);

  return {
    ...source,
    ...(baseUrl ? { LANGFUSE_BASEURL: baseUrl } : {}),
    ...(migrate ? { DIRECT_URL: migrate.url } : {}),
    ...(runtime ? { DATABASE_URL: runtime.url } : {}),
  };
}

const parsed = schema.safeParse(readEnv(process.env));

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
  throw new Error(`Invalid environment configuration:\n${details}`);
}

export const env: Env = parsed.data;

/**
 * Langfuse is configured only when we know *where* it is.
 *
 * The base URL is part of the condition on purpose. Treating two-of-three as
 * "configured" is what hands the SDK its `cloud.langfuse.com` default, and the
 * failure is invisible from here: traces are produced, the app looks healthy,
 * and a redacted child's answer is on a US vendor's disk. Fail closed instead —
 * an unconfigured destination disables tracing locally and refuses to boot a
 * deployed tier (`assertObservabilityReady`).
 */
export const isLangfuseConfigured =
  Boolean(env.LANGFUSE_PUBLIC_KEY) &&
  Boolean(env.LANGFUSE_SECRET_KEY) &&
  Boolean(env.LANGFUSE_BASEURL);

/**
 * The Langfuse environment every trace, observation and score is tagged with.
 *
 * This is the separation the dashboards and alerts depend on: a cost alert
 * scoped to `production` must never fire because someone ran the grading smoke
 * test on their laptop, and the training-data export must never pick up a
 * developer's throwaway run.
 */
const APP_ENV_TO_LANGFUSE_ENVIRONMENT: Record<Env["APP_ENV"], string> = {
  local: "development",
  preview: "preview",
  production: "production",
};

export const langfuseEnvironment: string =
  env.LANGFUSE_TRACING_ENVIRONMENT ?? APP_ENV_TO_LANGFUSE_ENVIRONMENT[env.APP_ENV];

export const isSentryConfigured = Boolean(env.NEXT_PUBLIC_SENTRY_DSN);

export const isDatabaseConfigured = Boolean(env.DATABASE_URL);

/**
 * Deployed environments must be observable. A missing Langfuse key in preview
 * or production is a configuration bug, not a soft degradation: an AI call we
 * cannot trace is, by team definition, not finished.
 */
export function assertObservabilityReady(): void {
  if (env.APP_ENV === "local") return;
  if (isLangfuseConfigured) return;

  const missing = [
    env.LANGFUSE_PUBLIC_KEY ? null : "LANGFUSE_PUBLIC_KEY",
    env.LANGFUSE_SECRET_KEY ? null : "LANGFUSE_SECRET_KEY",
    env.LANGFUSE_BASEURL ? null : "LANGFUSE_BASEURL (or LANGFUSE_BASE_URL)",
  ].filter((name): name is string => name !== null);

  throw new Error(
    `APP_ENV=${env.APP_ENV} requires a fully configured Langfuse. Missing: ` +
      `${missing.join(", ")}. A missing base URL is the dangerous one: the SDK ` +
      `would default to cloud.langfuse.com and ship our traces to a US vendor.`,
  );
}
