import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { startFakeIngestion, type FakeIngestion } from "@/lib/observability/fake-ingestion-server";

/**
 * Where a trace goes when the configuration is incomplete.
 *
 * `langfuse.test.ts` asserts what leaves the process. This file asserts the
 * question one step earlier and one step more dangerous: *which host* it leaves
 * for. The Langfuse SDK treats a missing `baseUrl` as "use cloud.langfuse.com",
 * so a half-configured deployment does not degrade into "no tracing" — it
 * degrades into "tracing to the US SaaS that ADR 0002 rejected because our
 * traces carry children's answers".
 *
 * The second half of the file asks the same question about a host that *is*
 * configured and is ours, but has not been proven safe to hold a child's
 * answer. See `trace-destination.ts`.
 *
 * Every test here loads the env module fresh, because `src/lib/env.ts` reads
 * `process.env` once at module load.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function loadEnv(vars: Record<string, string | undefined>) {
  for (const [name, value] of Object.entries(vars)) vi.stubEnv(name, value);
  vi.resetModules();
  return import("@/lib/env");
}

const KEYS = {
  LANGFUSE_PUBLIC_KEY: "pk-lf-test",
  LANGFUSE_SECRET_KEY: "sk-lf-test",
};

describe("Langfuse destination", () => {
  it("is not 'configured' when the keys are present but the host is not", async () => {
    const { isLangfuseConfigured } = await loadEnv({
      ...KEYS,
      LANGFUSE_BASEURL: undefined,
      LANGFUSE_BASE_URL: undefined,
    });

    expect(
      isLangfuseConfigured,
      "Two-of-three is what hands the SDK its cloud.langfuse.com default.",
    ).toBe(false);
  });

  it("refuses to boot a deployed tier that has keys but no host", async () => {
    const { assertObservabilityReady } = await loadEnv({
      ...KEYS,
      APP_ENV: "production",
      LANGFUSE_BASEURL: undefined,
      LANGFUSE_BASE_URL: undefined,
    });

    expect(() => assertObservabilityReady()).toThrow(/LANGFUSE_BASEURL/);
  });

  it("never builds a client that would reach cloud.langfuse.com", async () => {
    // APP_ENV=local, so nothing else stops this path: the only thing between a
    // half-configured local run and an external vendor is getLangfuse itself.
    await loadEnv({
      ...KEYS,
      APP_ENV: "local",
      LANGFUSE_BASEURL: undefined,
      LANGFUSE_BASE_URL: undefined,
    });
    const { getLangfuse } = await import("@/lib/observability/langfuse");

    expect(getLangfuse()).toBeNull();
  });

  it("accepts LANGFUSE_BASE_URL as an alias for LANGFUSE_BASEURL", async () => {
    // Our secret injection spells it with the underscore; the SDK and this repo
    // spell it without. One character must not decide where a trace lands.
    const { env, isLangfuseConfigured } = await loadEnv({
      ...KEYS,
      LANGFUSE_BASEURL: undefined,
      LANGFUSE_BASE_URL: "https://langfuse.example.invalid",
    });

    expect(env.LANGFUSE_BASEURL).toBe("https://langfuse.example.invalid");
    expect(isLangfuseConfigured).toBe(true);
  });

  it("prefers LANGFUSE_BASEURL when both spellings are set", async () => {
    const { env } = await loadEnv({
      ...KEYS,
      LANGFUSE_BASEURL: "https://canonical.example.invalid",
      LANGFUSE_BASE_URL: "https://alias.example.invalid",
    });

    expect(env.LANGFUSE_BASEURL).toBe("https://canonical.example.invalid");
  });
});

/**
 * The hardening gate (PRO-84).
 *
 * `checkLangfuseHardening` has been able to spot an open-registration Langfuse
 * since PRO-34, but its only caller was a script someone had to remember to
 * run. Nothing in the request path stopped a child's trace from landing on an
 * instance anyone could create an account on.
 *
 * These tests assert on the ingestion wire rather than on the decision object,
 * for the same reason `langfuse.test.ts` does: the question is not "did we
 * compute a verdict", it is "what left the process".
 */

/** Client-minted ids, as a real feature receives them from the browser. */
const CORRELATION_ID = "0199a3f1-8c42-7c19-9b7e-4a1f2d3e5c60";
const SESSION_ID = "0199a3f1-7b10-7aa4-8f31-9c2b6d4e1a07";

describe("hardening gate", () => {
  /** Live, https canonical URL, registration refused on policy. */
  let hardened: FakeIngestion;
  /** Live and reachable, but anyone can register: `ok: false`. */
  let openSignup: FakeIngestion;
  /** 404 on every path, health included: `reachable: false`. */
  let dead: FakeIngestion;

  beforeAll(async () => {
    [hardened, openSignup, dead] = await Promise.all([
      startFakeIngestion({ hardening: "hardened" }),
      startFakeIngestion({ hardening: "open-signup" }),
      startFakeIngestion({ hardening: "dead" }),
    ]);
  });

  afterAll(async () => {
    await Promise.all([hardened.close(), openSignup.close(), dead.close()]);
  });

  /**
   * Point a freshly loaded module graph at one of the doubles.
   *
   * `APP_ENV=production` throughout: the gate must hold on the tier where a
   * learner ref belongs to an actual child, and it is also the only tier where
   * the `audience: "synthetic"` declaration is ignored.
   */
  async function traceAiCallAgainst(instance: FakeIngestion, appEnv = "production") {
    instance.reset();
    await loadEnv({ ...KEYS, APP_ENV: appEnv, LANGFUSE_BASEURL: instance.baseUrl });
    return (await import("@/lib/observability/langfuse")).traceAiCall;
  }

  /** The trace-create event, the one that carries the learner binding. */
  function traceCreates(instance: FakeIngestion) {
    return instance.events.filter(
      (event) =>
        event.type.startsWith("trace") && (event.body as { name?: string }).name !== undefined,
    );
  }

  const LEARNER_CALL = {
    name: "grade.short-answer",
    learnerRef: "learner_7f3a91",
    correlationId: CORRELATION_ID,
    sessionId: SESSION_ID,
  };

  it("refuses a real learner's trace when the instance fails a hardening check", async () => {
    const traceAiCall = await traceAiCallAgainst(openSignup);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const output = await traceAiCall(LEARNER_CALL, async () => ({ output: "graded" }));

    expect(
      openSignup.events,
      "Anyone can register on this instance; a child's trace must not be on it.",
    ).toHaveLength(0);

    // The child is still graded. Losing a trace is a debugging cost; shipping a
    // learner ref to an open instance is not recoverable at all.
    expect(output).toBe("graded");

    // Suppressed, never silent: the failing check and its remedy are both said
    // out loud, and the dropped trace is named individually.
    const said = [...errors.mock.calls, ...warnings.mock.calls].flat().join("\n");
    expect(said).toMatch(/open_signup/);
    expect(said).toMatch(/AUTH_DISABLE_SIGNUP/);
    expect(said).toMatch(CORRELATION_ID);

    errors.mockRestore();
    warnings.mockRestore();
  });

  it("refuses a real learner's trace when hardening cannot be concluded at all", async () => {
    const traceAiCall = await traceAiCallAgainst(dead);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await traceAiCall(LEARNER_CALL, async () => ({ output: "graded" }));

    // The 2026-09-22 shape: the host answers 404 everywhere, and the signup
    // probe reads that as the strongest possible pass. `reachable: false` is
    // what keeps "we could not tell" from being spelled "it is fine".
    expect(
      dead.events,
      "An instance we cannot verify is unverified, not clean — no fail-open.",
    ).toHaveLength(0);

    const said = [...errors.mock.calls, ...warnings.mock.calls].flat().join("\n");
    expect(said).toMatch(/could not be verified|unverified/i);

    errors.mockRestore();
    warnings.mockRestore();
  });

  it("still sends a real learner's trace to an instance that passes", async () => {
    const traceAiCall = await traceAiCallAgainst(hardened);

    await traceAiCall(LEARNER_CALL, async () => ({ output: "graded" }));

    const [create] = traceCreates(hardened);
    expect(create, "The gate must not block the case it was built to allow.").toBeDefined();
    expect((create.body as { userId?: string }).userId).toBe("learner_7f3a91");
  });

  it("lets a dev/eval trace through an instance that fails hardening", async () => {
    const traceAiCall = await traceAiCallAgainst(openSignup);

    // No learnerRef, no sessionId, no submissionId — a dataset run, exactly the
    // shape `scripts/grading-eval.ts` emits. Nothing about a child can leak, so
    // this gate has no business stopping it.
    await traceAiCall({ name: "eval.rubric-agreement" }, async () => ({ output: "ok" }));

    expect(traceCreates(openSignup)).toHaveLength(1);
  });

  it("lets a canary through when it declares its fabricated learner ref", async () => {
    // `scripts/ai-smoke.ts`: a fake learner ref and a fake session on purpose,
    // because a canary that dropped them would stop proving the real shape.
    const traceAiCall = await traceAiCallAgainst(openSignup, "preview");

    await traceAiCall({ ...LEARNER_CALL, audience: "synthetic" }, async () => ({ output: "ok" }));

    const [create] = traceCreates(openSignup);
    expect(create).toBeDefined();
    // The claim is recorded in the data, not only in the source, so an audit of
    // the instance can tell the fabricated traces from the real ones.
    expect((create.body as { tags?: string[] }).tags).toContain("synthetic");
  });

  it("ignores the synthetic declaration in production", async () => {
    const traceAiCall = await traceAiCallAgainst(openSignup, "production");
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await traceAiCall({ ...LEARNER_CALL, audience: "synthetic" }, async () => ({ output: "ok" }));

    expect(
      openSignup.events,
      "There is no synthetic child in production; a learnerRef there is a real one.",
    ).toHaveLength(0);

    errors.mockRestore();
    warnings.mockRestore();
  });

  it("probes the instance once, not once per graded item", async () => {
    const traceAiCall = await traceAiCallAgainst(hardened);

    for (let i = 0; i < 3; i += 1) {
      await traceAiCall(LEARNER_CALL, async () => ({ output: "graded" }));
    }

    // Three hardening endpoints, one round of probes. The check is two network
    // round trips; paying that per graded item would be a latency bug of our
    // own making.
    const probes = hardened.paths.filter((path) => !path.includes("/api/public/ingestion"));
    expect(probes.filter((path) => path === "/api/public/health")).toHaveLength(1);
    expect(probes.filter((path) => path === "/api/auth/signup")).toHaveLength(1);
    expect(traceCreates(hardened)).toHaveLength(3);
  });

  it("does not hang a generation off a trace it just refused", async () => {
    // The hole this closes: `traceAiCall` suppresses the trace, and the wrapped
    // callback reaches for `getLangfuse()` itself and attaches a generation
    // carrying the correlation id anyway. The client is handed down instead.
    const traceAiCall = await traceAiCallAgainst(openSignup);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await traceAiCall(LEARNER_CALL, async (ctx) => {
      ctx.langfuse?.generation({ traceId: ctx.traceId ?? undefined, name: "grade.generation" });
      return { output: "graded" };
    });

    expect(openSignup.events).toHaveLength(0);

    errors.mockRestore();
    warnings.mockRestore();
  });
});

describe("classifyTraceAudience", () => {
  async function load(appEnv = "production") {
    await loadEnv({ ...KEYS, APP_ENV: appEnv, LANGFUSE_BASEURL: "https://lf.example.invalid" });
    return (await import("@/lib/observability/trace-destination")).classifyTraceAudience;
  }

  it("treats any one learner binding as enough", async () => {
    const classify = await load();

    expect(classify({ learnerRef: "learner_7f3a91" })).toBe("learner");
    expect(classify({ sessionId: SESSION_ID })).toBe("learner");
    expect(classify({ metadata: { submissionId: "sub_1" } })).toBe("learner");
  });

  it("treats a trace with no learner binding as synthetic", async () => {
    const classify = await load();

    expect(classify({})).toBe("synthetic");
    expect(classify({ metadata: { submissionId: undefined } })).toBe("synthetic");
  });

  it("honours a declared-synthetic canary outside production only", async () => {
    const preview = await load("preview");
    expect(preview({ learnerRef: "learner_smoke_0001", audience: "synthetic" })).toBe("synthetic");

    const production = await load("production");
    expect(production({ learnerRef: "learner_smoke_0001", audience: "synthetic" })).toBe("learner");
  });
});
