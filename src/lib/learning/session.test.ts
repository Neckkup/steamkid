/**
 * PRO-168: browsers that visited before PRO-115 hold a UUIDv4 sk_learner
 * cookie. Returning that value as-is caused POST /api/consent to fail the
 * app.is_uuidv7(public_ref) CHECK and return 500. ensureLearnerRef must
 * detect a non-v7 ref and reissue a fresh v7 cookie in its place.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { isUuidV7 } from "@/lib/ids";

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
  }),
}));

const { ensureLearnerRef, getLearnerRef, LEARNER_COOKIE } = await import("./session");

afterEach(() => {
  jar.clear();
});

describe("ensureLearnerRef", () => {
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

describe("getLearnerRef", () => {
  it("returns null when no cookie exists", async () => {
    expect(await getLearnerRef()).toBeNull();
  });

  it("returns the raw cookie value without validation", async () => {
    jar.set(LEARNER_COOKIE, "some-value");
    expect(await getLearnerRef()).toBe("some-value");
  });
});
