import { describe, expect, it } from "vitest";

import { REDACTED, pickAllowed, redactDeep, scrubText } from "./redact";

describe("scrubText", () => {
  it("removes email addresses", () => {
    expect(scrubText("contact nong.a@example.co.th please")).toBe(
      `contact ${REDACTED} please`,
    );
  });

  it("removes phone numbers and Thai national ids", () => {
    expect(scrubText("call 081-234-5678")).toBe(`call ${REDACTED}`);
    expect(scrubText("id 1-2345-67890-12-3")).toBe(`id ${REDACTED}`);
  });

  it("removes credentials embedded in a URL", () => {
    expect(scrubText("postgres://user:pw@db.internal/steamkid")).toBe(
      `postgres://${REDACTED}@db.internal/steamkid`,
    );
  });

  it("leaves harmless text alone", () => {
    expect(scrubText("the answer is 42 because water boils at 100C")).toBe(
      "the answer is 42 because water boils at 100C",
    );
  });
});

describe("redactDeep", () => {
  it("redacts denied keys at any depth", () => {
    const out = redactDeep({
      learnerRef: "lrn_123",
      profile: { firstName: "ก้อง", guardianEmail: "p@example.com" },
      headers: { authorization: "Bearer abc" },
    }) as Record<string, Record<string, string>>;

    expect(out.learnerRef).toBe("lrn_123");
    expect(out.profile.firstName).toBe(REDACTED);
    expect(out.profile.guardianEmail).toBe(REDACTED);
    expect(out.headers.authorization).toBe(REDACTED);
  });

  it("scrubs identifiers hiding in allowed free text", () => {
    const out = redactDeep({ answer: "my mum is at mum@example.com" }) as {
      answer: string;
    };
    expect(out.answer).toBe(`my mum is at ${REDACTED}`);
  });

  it("survives circular references and caps depth", () => {
    const node: Record<string, unknown> = { label: "root" };
    node.self = node;
    expect(redactDeep(node)).toEqual({ label: "root", self: "[CIRCULAR]" });

    expect(redactDeep({ a: { b: { c: "deep" } } }, 1)).toEqual({
      a: "[TRUNCATED]",
    });
  });

  it("redacts an Error down to name and scrubbed message", () => {
    const out = redactDeep(new Error("failed for kid@example.com")) as {
      name: string;
      message: string;
    };
    expect(out).toEqual({ name: "Error", message: `failed for ${REDACTED}` });
  });
});

describe("pickAllowed", () => {
  it("keeps only allow-listed keys", () => {
    const out = pickAllowed(
      { lessonId: "les_1", childName: "ก้อง", skillId: "skill_1" },
      ["lessonId", "skillId"],
    );
    expect(out).toEqual({ lessonId: "les_1", skillId: "skill_1" });
    expect(out.childName).toBeUndefined();
  });

  it("still redacts an allowed key holding identifying text", () => {
    const out = pickAllowed({ lessonId: "sent to kid@example.com" }, ["lessonId"]);
    expect(out.lessonId).toBe(`sent to ${REDACTED}`);
  });
});
