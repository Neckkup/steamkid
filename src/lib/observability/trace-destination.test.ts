import { afterEach, describe, expect, it, vi } from "vitest";

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
