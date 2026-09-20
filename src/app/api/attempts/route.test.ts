/**
 * The server-side gates on `POST /api/attempts` (PRO-44).
 *
 * The one that matters here is `minChars`: the practice screen disables the
 * submit button below it, but a stale tab or a direct POST used to walk a
 * four-character answer into the `pending_ai` queue, where PRO-8's grader would
 * later read it as real schoolwork. The gate now lives on the server, where the
 * project path (`POST /api/submissions`) has always had it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { listLessons, isWrittenItem, type WrittenItem } from "@/content";

/**
 * A cookie jar, because `POST` reads the learner cookie once an answer is long
 * enough to be worth storing. Every length rejection happens before this is
 * touched — which is itself part of what the "passes the gate" case proves.
 */
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

const { POST } = await import("./route");

async function firstWrittenPracticeItem(): Promise<WrittenItem> {
  for (const lesson of await listLessons()) {
    for (const item of lesson.items) {
      if (item.type === "short_text" && isWrittenItem(item)) return item;
    }
  }
  throw new Error("the course has no short_text item to test against");
}

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/attempts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function attempt(itemId: string, text: string) {
  return {
    itemId,
    answer: { type: "text", text },
    timeOnItemMs: 5_000,
    activeTimeOnItemMs: 4_000,
    answerChanges: 0,
    hintsUsed: 0,
  };
}

describe("POST /api/attempts — written answer length", () => {
  beforeEach(() => {
    jar.clear();
  });

  it("rejects an answer shorter than the item's minChars", async () => {
    const item = await firstWrittenPracticeItem();
    const response = await post(attempt(item.id, "สั้น"));

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "too_short", minChars: item.minChars });
  });

  it("does not let padding whitespace buy the length", async () => {
    const item = await firstWrittenPracticeItem();
    const response = await post(attempt(item.id, `  ok${" ".repeat(item.minChars)}  `));

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: "too_short" });
  });

  it("still reports an empty answer as empty, not as too short", async () => {
    const item = await firstWrittenPracticeItem();
    const response = await post(attempt(item.id, "   "));

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "empty_answer" });
  });

  it("counts characters the way the child's screen counts them", async () => {
    const item = await firstWrittenPracticeItem();
    // Astral characters are two UTF-16 units each; the counter under the answer
    // box says one. Counting units here would accept half the required length.
    const response = await post(attempt(item.id, "🛼".repeat(item.minChars - 1)));

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: "too_short" });
  });

  it("lets an answer at exactly minChars through the length gate", async () => {
    const item = await firstWrittenPracticeItem();
    const response = await post(attempt(item.id, "ก".repeat(item.minChars)));

    // No consent has been given in this jar, so the next gate stops it. What
    // matters is that it is no longer the length gate.
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "consent_required" });
  });
});
