import { describe, expect, it } from "vitest";

import {
  checkCredentialsInUse,
  checkLeakedCredentialsRevoked,
  type LeakedDigests,
} from "@/lib/observability/leaked-credentials";

/**
 * No real credential appears in this file, and none can: the checks compare
 * SHA-256 digests, so the fixtures below are stand-ins with their own digests
 * (`expected`). The pinned 2026-09-19 digests stay in the module, where a test
 * cannot reach them and a preimage cannot be written down.
 *
 * The cases are the states the live instance was actually observed in on
 * 2026-09-23 — two working key pairs on one project, and an edge that answers
 * 403 to a client it dislikes.
 */

const REVOKED_PAIR = { publicKey: "pk-lf-leaked-fixture", secretKey: "sk-lf-leaked-fixture" };
const CONTROL_PAIR = { publicKey: "pk-lf-current-fixture", secretKey: "sk-lf-current-fixture" };
const GEMINI = "gemini-leaked-fixture";

async function sha256Hex(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

const expected: LeakedDigests = {
  langfusePublicKey: await sha256Hex(REVOKED_PAIR.publicKey),
  langfuseSecretKey: await sha256Hex(REVOKED_PAIR.secretKey),
  geminiApiKey: await sha256Hex(GEMINI),
};

const BASE_URL = "https://langfuse.example.invalid";

/** Basic auth is the only thing that distinguishes the two callers here. */
function authOf(init: RequestInit | undefined): string {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  return headers.authorization ?? "";
}

function instance(responses: { revoked: number; control?: number }): typeof fetch {
  const revokedAuth = `Basic ${btoa(`${REVOKED_PAIR.publicKey}:${REVOKED_PAIR.secretKey}`)}`;
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const status = authOf(init) === revokedAuth ? responses.revoked : (responses.control ?? 200);
    return new Response(status === 200 ? JSON.stringify({ data: [] }) : "no", { status });
  }) as unknown as typeof fetch;
}

describe("checkCredentialsInUse", () => {
  it("passes when nothing in use is one of the leaked values", async () => {
    const finding = await checkCredentialsInUse({
      langfusePublicKey: CONTROL_PAIR.publicKey,
      langfuseSecretKey: CONTROL_PAIR.secretKey,
      geminiApiKey: "some-other-key",
      expected,
    });

    expect(finding.ok).toBe(true);
  });

  /**
   * The state on 2026-09-23: the Langfuse pair had been replaced, the Gemini key
   * had not. A published key that only spends our budget is a real problem and
   * not this gate's — blocking traces would not take it back.
   */
  it("flags a leaked Gemini key without blocking observability", async () => {
    const finding = await checkCredentialsInUse({
      langfusePublicKey: CONTROL_PAIR.publicKey,
      langfuseSecretKey: CONTROL_PAIR.secretKey,
      geminiApiKey: GEMINI,
      expected,
    });

    expect(finding.ok).toBe(false);
    expect(finding.severity).toBe("warning");
    expect(finding.reason).toContain("GEMINI_API_KEY");
  });

  it("blocks when the Langfuse key in use is itself a published one", async () => {
    const finding = await checkCredentialsInUse({
      langfusePublicKey: REVOKED_PAIR.publicKey,
      langfuseSecretKey: REVOKED_PAIR.secretKey,
      expected,
    });

    expect(finding.ok).toBe(false);
    expect(finding.severity).toBe("blocker");
  });
});

describe("checkLeakedCredentialsRevoked", () => {
  /**
   * The defect that motivated the whole check. Comparing the configured key
   * against the leaked one says "rotated" as soon as a *second* pair is issued;
   * only the old pair can say whether it still opens the door.
   */
  it("blocks while the leaked pair still reads the project", async () => {
    const finding = await checkLeakedCredentialsRevoked({
      baseUrl: BASE_URL,
      revoked: REVOKED_PAIR,
      control: CONTROL_PAIR,
      expected,
      fetchImpl: instance({ revoked: 200 }),
    });

    expect(finding.ok).toBe(false);
    expect(finding.severity).toBe("blocker");
    expect(finding.reason).toContain("still reads");
  });

  it("passes once the instance rejects the leaked pair and still accepts ours", async () => {
    const finding = await checkLeakedCredentialsRevoked({
      baseUrl: BASE_URL,
      revoked: REVOKED_PAIR,
      control: CONTROL_PAIR,
      expected,
      fetchImpl: instance({ revoked: 401, control: 200 }),
    });

    expect(finding.ok, "Deleting the old pair must open the gate with no deploy.").toBe(true);
  });

  /**
   * `langfuse.homekup.com` sits behind an edge that answered
   * `403 error code: 1010` to a user agent it disliked — identically for a valid
   * pair and a leaked one. Reading 403 as "revoked" would promote a bot rule
   * into a security clearance, so only 401 counts.
   */
  it("does not read an edge 403 as a revocation", async () => {
    const finding = await checkLeakedCredentialsRevoked({
      baseUrl: BASE_URL,
      revoked: REVOKED_PAIR,
      control: CONTROL_PAIR,
      expected,
      fetchImpl: instance({ revoked: 403, control: 403 }),
    });

    expect(finding.ok).toBe(false);
    expect(finding.reason).toContain("usable answer");
  });

  /**
   * A 401 proves revocation only if the same endpoint would have said yes to
   * something. An instance refusing everyone is an outage, not a fix.
   */
  it("does not read a blanket refusal as a revocation", async () => {
    const finding = await checkLeakedCredentialsRevoked({
      baseUrl: BASE_URL,
      revoked: REVOKED_PAIR,
      control: CONTROL_PAIR,
      expected,
      fetchImpl: instance({ revoked: 401, control: 401 }),
    });

    expect(finding.ok).toBe(false);
    expect(finding.reason).toContain("did not get through either");
  });

  it("fails closed when nobody supplied the pair to test with", async () => {
    const finding = await checkLeakedCredentialsRevoked({
      baseUrl: BASE_URL,
      control: CONTROL_PAIR,
      expected,
      fetchImpl: instance({ revoked: 401 }),
    });

    expect(finding.ok, "No evidence and still open are the same state here.").toBe(false);
    expect(finding.remedy).toContain("LANGFUSE_REVOKED_PUBLIC_KEY");
  });

  /**
   * Without the pin, "revocation" could be demonstrated with any string at all,
   * since any string gets a 401.
   */
  it("refuses to accept a 401 earned by some other credential", async () => {
    const finding = await checkLeakedCredentialsRevoked({
      baseUrl: BASE_URL,
      revoked: { publicKey: "pk-lf-other-fixture", secretKey: "sk-lf-other-fixture" },
      control: CONTROL_PAIR,
      expected,
      fetchImpl: instance({ revoked: 401, control: 200 }),
    });

    expect(finding.ok).toBe(false);
    expect(finding.reason).toContain("do not match the pair recorded as leaked");
  });

  it("fails closed when the probe throws", async () => {
    const finding = await checkLeakedCredentialsRevoked({
      baseUrl: BASE_URL,
      revoked: REVOKED_PAIR,
      control: CONTROL_PAIR,
      expected,
      fetchImpl: (async () => {
        throw new Error("ECONNRESET");
      }) as unknown as typeof fetch,
    });

    expect(finding.ok).toBe(false);
  });
});
