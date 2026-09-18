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
    expect(scrubText("id 1 2345 67890 12 3")).toBe(`id ${REDACTED}`);
    expect(scrubText("id 1234567890123")).toBe(`id ${REDACTED}`);
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

  it("removes phone numbers in the other shapes children's parents write them", () => {
    expect(scrubText("call +66 81 234 5678")).toBe(`call ${REDACTED}`);
    expect(scrubText("call +6681234567")).toBe(`call ${REDACTED}`);
    expect(scrubText("call (02) 123-4567")).toBe(`call ${REDACTED}`);
    expect(scrubText("call 081 234 5678")).toBe(`call ${REDACTED}`);
    expect(scrubText("call 0812345678")).toBe(`call ${REDACTED}`);
  });

  // PRO-23: the phone regex used to eat digit runs separated by spaces, which is
  // exactly what a child's maths answer looks like. A grading trace we cannot
  // read is worse than useless.
  it("leaves a child's maths work intact", () => {
    const answers = [
      "2 + 2 = 4",
      "1 2 3 4 5 6 7 8 9",
      "I counted 100 200 300 400 500 marbles",
      "10 20 30 40 50 60 70 80 90 100",
      "My answer is 12345678",
      "3 + 4 + 5 + 6 + 7 + 8 + 9 = 42",
      "1+2+3+4+5+6+7+8+9",
      "pi is about 3.14159",
      "the sequence goes 2 4 8 16 32 64 128 256",
    ];
    for (const answer of answers) {
      expect(scrubText(answer), answer).toBe(answer);
    }
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

  it("detects a cycle that closes further down the path", () => {
    const root: Record<string, unknown> = { label: "root" };
    root.child = { label: "child", back: root };
    expect(redactDeep(root)).toEqual({
      label: "root",
      child: { label: "child", back: "[CIRCULAR]" },
    });
  });

  // PRO-23: an object referenced twice in parallel is not a cycle. Dropping it
  // meant trace metadata lost data silently.
  it("keeps an object that is shared rather than circular", () => {
    const shared = { score: 4 };
    expect(redactDeep({ first: shared, second: shared })).toEqual({
      first: { score: 4 },
      second: { score: 4 },
    });

    const criterion = { id: "c1" };
    expect(redactDeep({ criteria: [criterion, criterion] })).toEqual({
      criteria: [{ id: "c1" }, { id: "c1" }],
    });

    const rubric = { skillId: "skill_1", levels: [1, 2, 3] };
    expect(
      redactDeep({ input: { rubric }, output: { rubric }, meta: { rubric } }),
    ).toEqual({
      input: { rubric },
      output: { rubric },
      meta: { rubric },
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
