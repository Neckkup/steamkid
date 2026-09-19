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

  // PRO-32: PRO-23 fixed space-separated digits, but two shapes a STEAM app
  // produces routinely were still blanked, so a science/maths grading trace was
  // still unreadable.
  it("leaves science magnitudes and dashed arithmetic intact", () => {
    const answers = [
      // Case 1 — a contiguous 9+ digit run that carries a unit.
      "the sun is 149600000 km away",
      "light travels 299792458 m/s",
      "Earth's circumference is 40075017 m",
      "the star is 299792458000 m away",
      "ดวงอาทิตย์อยู่ห่าง 149600000 กิโลเมตร",
      // Case 1 — the same run inside arithmetic rather than next to a unit.
      "299792458 × 2 = 599584916",
      "123456789 + 1 = 123456790",
      // Case 2 — subtraction written without spaces.
      "1000-200-300 = 500",
      "5000-1000-2000 = 2000",
      // Previously-known false positive, fixed by the same narrowing.
      "the launch was 01-15-2024",
    ];
    for (const answer of answers) {
      expect(scrubText(answer), answer).toBe(answer);
    }
  });

  // PRO-32 regression guard: the schoolwork exemption must not become a way to
  // launder a real number through a lesson-shaped sentence.
  it("never lets a phone number earn the schoolwork exemption", () => {
    const leaks = [
      // Leading 0 is a trunk prefix, so no context can rescue it.
      "0812345678 km",
      "0812345678 = my number",
      "081-234-5678 = call me",
      // Phone punctuation is not maths.
      "+66 81 234 5678 km",
      "(02) 123-4567 = home",
      // A contact word in the phrase vetoes the exemption outright.
      "call 812345678 m",
      "โทร 812345678 กม",
      "tel 123456789 + 1",
      // A national id gets no exemption at all.
      "1234567890123 km",
      "1-2345-67890-12-3 = id",
      // "in"/"dollars" are English words, not units.
      "812345678 in the morning",
      "812345678 dollars",
    ];
    for (const text of leaks) {
      expect(scrubText(text), text).toContain(REDACTED);
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

  // PRO-25: `/token/i` was redacting the SDK's usage numbers, so a trace read
  // "inputTokens": "[REDACTED]" and looked like the layer was broken.
  it("keeps numeric token counts", () => {
    expect(
      redactDeep({
        usage: {
          inputTokens: 412,
          outputTokens: 24,
          cacheCreationTokens: 0,
          cacheReadTokens: 1024,
          total_tokens: 436,
          tokenCount: 436,
          maxTokens: 4096,
        },
      }),
    ).toEqual({
      usage: {
        inputTokens: 412,
        outputTokens: 24,
        cacheCreationTokens: 0,
        cacheReadTokens: 1024,
        total_tokens: 436,
        tokenCount: 436,
        maxTokens: 4096,
      },
    });
  });

  it("still redacts every token that could be a credential", () => {
    const out = redactDeep({
      token: "eyJhbGciOi",
      tokens: ["eyJhbGciOi"],
      accessToken: "at_1",
      refresh_token: "rt_1",
      idToken: "it_1",
      apiToken: "api_1",
      // Not in the counting vocabulary, so the broad deny rule still wins.
      resetToken: "reset_1",
      inviteToken: "inv_1",
      otpToken: 123456,
      // Counting vocabulary, but a string value is not a measurement.
      inputTokens: "eyJhbGciOi",
    }) as Record<string, string>;

    for (const [key, value] of Object.entries(out)) {
      expect(value, key).toBe(REDACTED);
    }
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
