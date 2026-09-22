import { describe, expect, it } from "vitest";

import { checkLangfuseHardening } from "@/lib/observability/langfuse-hardening";

/**
 * The cases here are the two real responses `langfuse.homekup.com` gave on
 * 2026-09-19, plus the hardened responses we expect after the fix. A freshly
 * provisioned Langfuse passes the v4 gate and serves HTTPS while failing both
 * of these, which is exactly why they are checked separately.
 */

type Route = (request: { url: string; method: string }) => Response;

function router(routes: Record<string, Route>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    for (const [suffix, route] of Object.entries(routes)) {
      if (url.endsWith(suffix)) return route({ url, method });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Every reachable fixture has to look like a live Langfuse first. */
const HEALTHY: Route = () => json({ status: "OK", version: "4.37.0" });

/** What the live instance actually returned before hardening. */
const OPEN_INSTANCE = {
  "/api/public/health": HEALTHY,
  "/api/auth/providers": () =>
    json({
      credentials: {
        id: "credentials",
        name: "credentials",
        type: "credentials",
        signinUrl: "http://langfuse.homekup.com/api/auth/signin/credentials",
        callbackUrl: "http://langfuse.homekup.com/api/auth/callback/credentials",
      },
    }),
  "/api/auth/signup": () =>
    json({ message: { name: "ZodError", message: "expected string, received undefined" } }, 400),
} satisfies Record<string, Route>;

const HARDENED_INSTANCE = {
  "/api/public/health": HEALTHY,
  "/api/auth/providers": () =>
    json({
      credentials: {
        id: "credentials",
        name: "credentials",
        type: "credentials",
        signinUrl: "https://langfuse.homekup.com/api/auth/signin/credentials",
        callbackUrl: "https://langfuse.homekup.com/api/auth/callback/credentials",
      },
    }),
  "/api/auth/signup": () => json({ message: "Sign up is disabled." }, 422),
} satisfies Record<string, Route>;

describe("checkLangfuseHardening", () => {
  it("flags the two defects the live instance actually had", async () => {
    const report = await checkLangfuseHardening({
      baseUrl: "https://langfuse.homekup.com",
      fetchImpl: router(OPEN_INSTANCE),
    });

    expect(report.ok).toBe(false);
    expect(report.reachable).toBe(true);

    const signup = report.findings.find((f) => f.id === "open_signup");
    expect(signup?.ok).toBe(false);
    expect(signup?.severity).toBe("blocker");
    expect(signup?.remedy).toContain("AUTH_DISABLE_SIGNUP");

    const tls = report.findings.find((f) => f.id === "canonical_url_tls");
    expect(tls?.ok).toBe(false);
    expect(tls?.reason).toContain("plaintext");
    expect(tls?.remedy).toContain("NEXTAUTH_URL");
  });

  it("passes a hardened instance", async () => {
    const report = await checkLangfuseHardening({
      baseUrl: "https://langfuse.homekup.com",
      fetchImpl: router(HARDENED_INSTANCE),
    });

    expect(report.ok).toBe(true);
    expect(report.findings).toHaveLength(2);
    expect(report.findings.every((f) => f.ok)).toBe(true);
  });

  it("treats a signup route that is not served at all as a pass", async () => {
    const report = await checkLangfuseHardening({
      baseUrl: "https://langfuse.homekup.com",
      fetchImpl: router({
        "/api/public/health": HEALTHY,
        "/api/auth/providers": HARDENED_INSTANCE["/api/auth/providers"],
      }),
    });

    expect(report.ok).toBe(true);
    expect(report.findings.find((f) => f.id === "open_signup")?.ok).toBe(true);
  });

  /**
   * The state `langfuse.homekup.com` was actually in on 2026-09-22: the origin
   * had gone away and the edge answered a plaintext `404 page not found` on
   * every path. Before the liveness gate this scored as one passing finding,
   * because a 404 on the signup route reads as "compiled out" — a vanished host
   * reported as safe to hold a child's answer.
   */
  it("does not read a host that 404s everything as a hardened one", async () => {
    const report = await checkLangfuseHardening({
      baseUrl: "https://langfuse.homekup.com",
      fetchImpl: router({}), // the router's default is a bare 404
    });

    expect(report.ok).toBe(false);
    expect(report.reachable).toBe(false);
    expect(report.findings.find((f) => f.id === "open_signup")).toBeUndefined();

    const live = report.findings.find((f) => f.id === "instance_live");
    expect(live?.ok).toBe(false);
    expect(live?.severity).toBe("blocker");
    expect(live?.reason).toContain("404");
  });

  it("tolerates a trailing slash on the base URL", async () => {
    const requested: string[] = [];
    const report = await checkLangfuseHardening({
      baseUrl: "https://langfuse.homekup.com/",
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        requested.push(String(input));
        return router(HARDENED_INSTANCE)(input, init);
      }) as unknown as typeof fetch,
    });

    expect(requested).toContain("https://langfuse.homekup.com/api/auth/providers");
    expect(requested).toContain("https://langfuse.homekup.com/api/auth/signup");
    expect(report.ok).toBe(true);
  });

  it("fails closed when there is no instance configured", async () => {
    const report = await checkLangfuseHardening({});
    expect(report.ok).toBe(false);
    expect(report.reachable).toBe(false);
    expect(report.findings).toHaveLength(0);
  });

  it("degrades to 'checked less' rather than 'blocked everything' when an endpoint moves", async () => {
    const report = await checkLangfuseHardening({
      baseUrl: "https://langfuse.homekup.com",
      // A live Langfuse whose auth endpoints have moved under it.
      fetchImpl: (async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/api/public/health")) return HEALTHY({ url: "", method: "GET" });
        throw new Error("ECONNRESET");
      }) as unknown as typeof fetch,
    });

    // Nothing could be concluded, so nothing is asserted as safe either.
    expect(report.ok).toBe(false);
    expect(report.reachable).toBe(false);
    expect(report.findings).toHaveLength(0);
  });

  it("fails closed when the instance itself cannot be reached", async () => {
    const report = await checkLangfuseHardening({
      baseUrl: "https://langfuse.homekup.com",
      fetchImpl: (async () => {
        throw new Error("ECONNRESET");
      }) as unknown as typeof fetch,
    });

    expect(report.ok).toBe(false);
    expect(report.reachable).toBe(false);
    expect(report.findings.find((f) => f.id === "instance_live")?.reason).toContain("ECONNRESET");
  });
});
