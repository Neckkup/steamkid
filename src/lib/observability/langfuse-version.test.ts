import { describe, expect, it } from "vitest";

import {
  MINIMUM_LANGFUSE_MAJOR,
  PINNED_LANGFUSE_TAG,
  checkLangfuseServerVersion,
  parseLangfuseMajor,
} from "@/lib/observability/langfuse-version";

/**
 * The case that motivates this file: upstream ships v3 and v4 in parallel, so a
 * v3 instance answers every request, accepts every trace, and still cannot run
 * the alerts or serve the metrics API the dashboards query. The guard has to
 * reject it, not just notice it.
 */

function fakeHealth(body: unknown, init: { status?: number } = {}): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("parseLangfuseMajor", () => {
  it("reads the major from the shapes Langfuse actually reports", () => {
    expect(parseLangfuseMajor("4.38.0")).toBe(4);
    expect(parseLangfuseMajor("v4.38.0")).toBe(4);
    expect(parseLangfuseMajor("3.225.8")).toBe(3);
    expect(parseLangfuseMajor(" 4.0.0-rc.1 ")).toBe(4);
  });

  it("refuses to guess at anything it cannot read", () => {
    expect(parseLangfuseMajor("")).toBeNull();
    expect(parseLangfuseMajor("latest")).toBeNull();
    expect(parseLangfuseMajor("4")).toBeNull();
  });
});

describe("checkLangfuseServerVersion", () => {
  it("accepts the pinned tag", async () => {
    const result = await checkLangfuseServerVersion({
      baseUrl: "https://langfuse.example",
      fetchImpl: fakeHealth({ status: "OK", version: PINNED_LANGFUSE_TAG.slice(1) }),
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe("ok");
    expect(result.major).toBe(MINIMUM_LANGFUSE_MAJOR);
  });

  it("rejects a healthy v3 instance and says why", async () => {
    const result = await checkLangfuseServerVersion({
      baseUrl: "https://langfuse.example",
      fetchImpl: fakeHealth({ status: "OK", version: "3.225.8" }),
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("too_old");
    expect(result.version).toBe("3.225.8");
    expect(result.reason).toContain("alerting");
    expect(result.reason).toContain(PINNED_LANGFUSE_TAG);
  });

  it("tolerates a trailing slash on the base URL", async () => {
    let requested = "";
    const result = await checkLangfuseServerVersion({
      baseUrl: "https://langfuse.example/",
      fetchImpl: (async (url: string) => {
        requested = String(url);
        return new Response(JSON.stringify({ version: "4.38.0" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });
    expect(requested).toBe("https://langfuse.example/api/public/health");
    expect(result.ok).toBe(true);
  });

  it("fails closed when the instance is unset, unreachable, or mute", async () => {
    const unset = await checkLangfuseServerVersion({});
    expect(unset.ok).toBe(false);
    expect(unset.status).toBe("not_configured");

    const down = await checkLangfuseServerVersion({
      baseUrl: "https://langfuse.example",
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    expect(down.ok).toBe(false);
    expect(down.status).toBe("unreachable");

    const http500 = await checkLangfuseServerVersion({
      baseUrl: "https://langfuse.example",
      fetchImpl: fakeHealth({}, { status: 500 }),
    });
    expect(http500.ok).toBe(false);
    expect(http500.status).toBe("unreachable");

    const noVersion = await checkLangfuseServerVersion({
      baseUrl: "https://langfuse.example",
      fetchImpl: fakeHealth({ status: "OK" }),
    });
    expect(noVersion.ok).toBe(false);
    expect(noVersion.status).toBe("unparseable");
  });
});
