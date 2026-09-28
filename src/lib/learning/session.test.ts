/**
 * getLearnerRef / ensureLearnerRef: ownership check and cookie-claim (PRO-197).
 *
 * PRO-168 regression: browsers that visited before PRO-115 hold a UUIDv4
 * sk_learner cookie. ensureLearnerRef must detect a non-v7 ref and reissue a
 * fresh v7 cookie in its place.
 *
 * PRO-197: getLearnerRef now validates guardian_link ownership and performs the
 * one-time cookie claim for pre-auth learners. Tests mock auth() and the DB
 * to drive both branches.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { isUuidV7, uuidv7 } from "@/lib/ids";

const jar = new Map<string, string>();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = jar.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string) => {
      jar.set(name, value);
    },
    delete: (name: string) => {
      jar.delete(name);
    },
  }),
}));

// Default: no session, no DB
let authResult: { uid: string; role: string } | null = null;
let dbRows: Array<Array<Record<string, unknown>>> = [];
let dbCallIndex = 0;

vi.mock("@/auth", () => ({
  auth: vi.fn().mockImplementation(async () => authResult),
}));

vi.mock("@/lib/events/runtime", () => ({
  getBehaviourDb: vi.fn().mockImplementation(() => {
    if (dbRows.length === 0) return null;
    const rows = dbRows;
    let callIdx = 0;
    return {
      query: vi.fn().mockImplementation(async () => {
        const result = rows[callIdx] ?? [];
        callIdx++;
        return { rows: result };
      }),
    };
  }),
}));

const { ensureLearnerRef, getLearnerRef, LEARNER_COOKIE } = await import("./session");

afterEach(() => {
  jar.clear();
  authResult = null;
  dbRows = [];
  dbCallIndex = 0;
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// getLearnerRef — no session
// ---------------------------------------------------------------------------
describe("getLearnerRef — no session, no DB", () => {
  it("returns null when no cookie exists", async () => {
    expect(await getLearnerRef()).toBeNull();
  });

  it("returns cookie value when no session and no DB (local fallback)", async () => {
    const ref = uuidv7();
    jar.set(LEARNER_COOKIE, ref);
    expect(await getLearnerRef()).toBe(ref);
  });

  it("returns null for a non-v7 cookie value", async () => {
    jar.set(LEARNER_COOKIE, "9f1d4e2a-7c3b-4d81-9a1b-2c3d4e5f6080");
    expect(await getLearnerRef()).toBeNull();
  });
});

describe("getLearnerRef — session present, DB present", () => {
  it("returns null when no cookie exists", async () => {
    authResult = { uid: uuidv7(), role: "guardian" };
    dbRows = [];
    expect(await getLearnerRef()).toBeNull();
  });

  it("returns the cookie when guardian_link links user to learner", async () => {
    const ref = uuidv7();
    jar.set(LEARNER_COOKIE, ref);
    authResult = { uid: uuidv7(), role: "guardian" };
    // First query: guardian_link match → 1 row
    const learnerId = uuidv7();
    dbRows = [[{ learner_id: learnerId }]];
    expect(await getLearnerRef()).toBe(ref);
  });

  // D7: cookie owned by another parent. getLearnerRef must return null without
  // mutating cookies — store.delete() throws in Server Component render context.
  // The caller page redirects to /children where picking a child overwrites the
  // cookie.
  it("returns null when linked to a different parent (does not clear cookie)", async () => {
    const ref = uuidv7();
    jar.set(LEARNER_COOKIE, ref);
    authResult = { uid: uuidv7(), role: "guardian" };
    const otherId = uuidv7();
    // First query: no link for this user; second query: link exists for someone else
    dbRows = [[], [{ guardian_user_id: otherId }]];
    const result = await getLearnerRef();
    expect(result).toBeNull();
    // Cookie must NOT be deleted — caller page handles redirect
    expect(jar.has(LEARNER_COOKIE)).toBe(true);
  });

  it("claims an unclaimed learner and returns the cookie", async () => {
    const ref = uuidv7();
    jar.set(LEARNER_COOKIE, ref);
    authResult = { uid: uuidv7(), role: "guardian" };
    const learnerId = uuidv7();
    // First: no link for this user; second: no link at all; third: learner row; fourth: insert guardian_link; fifth: no cache rows
    dbRows = [
      [],                           // guardian_link check for this user
      [],                           // any guardian_link check
      [{ id: learnerId }],          // learner SELECT
      [],                           // guardian_link INSERT (ON CONFLICT DO NOTHING)
      [],                           // learner_consent_cache SELECT
    ];
    const result = await getLearnerRef();
    expect(result).toBe(ref);
  });
});

// ---------------------------------------------------------------------------
// ensureLearnerRef — no session, no DB (backward-compat)
// ---------------------------------------------------------------------------
describe("ensureLearnerRef — no session, no DB", () => {
  it("creates a fresh UUIDv7 cookie when none exists", async () => {
    const ref = await ensureLearnerRef();
    expect(isUuidV7(ref)).toBe(true);
    expect(jar.get(LEARNER_COOKIE)).toBe(ref);
  });

  it("returns an existing v7 cookie unchanged", async () => {
    const first = await ensureLearnerRef();
    const second = await ensureLearnerRef();
    expect(second).toBe(first);
  });

  it("replaces a legacy UUIDv4 cookie with a fresh UUIDv7 (PRO-168 regression)", async () => {
    const legacyV4 = "9f1d4e2a-7c3b-4d81-9a1b-2c3d4e5f6080";
    jar.set(LEARNER_COOKIE, legacyV4);

    const ref = await ensureLearnerRef();

    expect(ref).not.toBe(legacyV4);
    expect(isUuidV7(ref)).toBe(true);
    expect(jar.get(LEARNER_COOKIE)).toBe(ref);
  });

  it("replaces any non-v7 cookie value regardless of format", async () => {
    jar.set(LEARNER_COOKIE, "not-a-uuid-at-all");
    const ref = await ensureLearnerRef();
    expect(isUuidV7(ref)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Ownership check: getLearnerRef with session but no DB (local fallback)
// ---------------------------------------------------------------------------
describe("getLearnerRef — session present, no DB (local fallback)", () => {
  it("returns cookie value without DB validation", async () => {
    const ref = uuidv7();
    jar.set(LEARNER_COOKIE, ref);
    authResult = { uid: uuidv7(), role: "guardian" };
    // getBehaviourDb returns null (no DB)
    dbRows = [];
    const result = await getLearnerRef();
    expect(result).toBe(ref);
  });
});
