/**
 * Children API — integration tests against a real Postgres database.
 *
 * GET /api/children: returns the children linked to the signed-in parent.
 * POST /api/children: creates a child and links it to the parent.
 * POST /api/children/active: switches the active child (ownership check).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/lib/db/test-database";
import { setBehaviourDb } from "@/lib/events/runtime";
import { uuidv7 } from "@/lib/ids";

let db: TestDatabase;
let userId: string;

// Session stub
let sessionStub: { uid: string; role: string } | null = null;
vi.mock("@/auth", () => ({
  auth: vi.fn().mockImplementation(async () => sessionStub),
}));

// Cookie jar
const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const v = jar.get(name);
      return v === undefined ? undefined : { name, value: v };
    },
    set: (name: string, value: string) => jar.set(name, value),
    delete: (name: string) => jar.delete(name),
  }),
}));

const { GET, POST } = await import("./route");
const { POST: POST_ACTIVE } = await import("./active/route");

beforeAll(async () => {
  db = await createTestDatabase();
  setBehaviourDb(db);
}, 120_000);

afterAll(async () => {
  setBehaviourDb(null);
  await db.close();
});

beforeEach(async () => {
  jar.clear();
  sessionStub = null;
  userId = uuidv7();
  await db.query(
    `INSERT INTO identity.user_account (id, role, email, auth_provider, auth_subject_id)
     VALUES ($1::uuid, 'guardian', $2, 'google', $1::text)`,
    [userId, `user-${userId}@test.local`],
  );
});

// ---------------------------------------------------------------------------
// GET /api/children
// ---------------------------------------------------------------------------
describe("GET /api/children", () => {
  it("returns 401 without a session", async () => {
    const response = await GET();
    expect(response.status).toBe(401);
  });

  it("returns an empty list when parent has no children", async () => {
    sessionStub = { uid: userId, role: "guardian" };
    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json() as { children: unknown[] };
    expect(body.children).toEqual([]);
  });

  it("returns linked children with active flag", async () => {
    sessionStub = { uid: userId, role: "guardian" };

    // Create two children
    const learnerId = uuidv7();
    const ref = uuidv7();
    await db.query(
      `INSERT INTO app.learner (id, public_ref, grade_band) VALUES ($1::uuid, $2::uuid, 'p5')`,
      [learnerId, ref],
    );
    await db.query(
      `INSERT INTO identity.learner_profile (learner_id, display_name, birth_year_month)
       VALUES ($1::uuid, 'น้องทดสอบ', '2015-01-01'::date)`,
      [learnerId],
    );
    await db.query(
      `INSERT INTO app.guardian_link (guardian_user_id, learner_id, relationship, verified_at)
       VALUES ($1::uuid, $2::uuid, 'parent', now())`,
      [userId, learnerId],
    );

    jar.set("sk_learner", ref);

    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json() as { children: Array<{ learnerRef: string; nickname: string; active: boolean }> };
    expect(body.children).toHaveLength(1);
    expect(body.children[0]).toMatchObject({ learnerRef: ref, nickname: "น้องทดสอบ", active: true });
  });
});

// ---------------------------------------------------------------------------
// POST /api/children
// ---------------------------------------------------------------------------
describe("POST /api/children", () => {
  it("returns 401 without a session", async () => {
    const response = await POST(
      new Request("https://test/api/children", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nickname: "น้อง", birthYearMonth: "2015-03" }),
      }),
    );
    expect(response.status).toBe(401);
  });

  it("creates a child and returns learnerRef", async () => {
    sessionStub = { uid: userId, role: "guardian" };

    const response = await POST(
      new Request("https://test/api/children", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nickname: "น้องใหม่", birthYearMonth: "2015-06" }),
      }),
    );
    expect(response.status).toBe(201);
    const body = await response.json() as { learnerRef: string };
    expect(body.learnerRef).toBeTruthy();

    // Row should exist
    const { rows } = await db.query<{ display_name: string }>(
      `SELECT lp.display_name FROM identity.learner_profile lp
       JOIN app.learner l ON l.id = lp.learner_id
       WHERE l.public_ref = $1::uuid`,
      [body.learnerRef],
    );
    expect(rows[0]?.display_name).toBe("น้องใหม่");
  });

  it("returns 400 for invalid birthYearMonth", async () => {
    sessionStub = { uid: userId, role: "guardian" };

    const response = await POST(
      new Request("https://test/api/children", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nickname: "น้อง", birthYearMonth: "2015" }),
      }),
    );
    expect(response.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /api/children/active
// ---------------------------------------------------------------------------
describe("POST /api/children/active", () => {
  it("returns 401 without a session", async () => {
    const response = await POST_ACTIVE(
      new Request("https://test/api/children/active", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ learnerRef: uuidv7() }),
      }),
    );
    expect(response.status).toBe(401);
  });

  it("returns 404 for a learner not owned by the user", async () => {
    sessionStub = { uid: userId, role: "guardian" };
    const otherRef = uuidv7();

    const response = await POST_ACTIVE(
      new Request("https://test/api/children/active", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ learnerRef: otherRef }),
      }),
    );
    expect(response.status).toBe(404);
  });

  it("switches the active child and sets the cookie", async () => {
    sessionStub = { uid: userId, role: "guardian" };

    const learnerId = uuidv7();
    const ref = uuidv7();
    await db.query(
      `INSERT INTO app.learner (id, public_ref, grade_band) VALUES ($1::uuid, $2::uuid, 'p5')`,
      [learnerId, ref],
    );
    await db.query(
      `INSERT INTO app.guardian_link (guardian_user_id, learner_id, relationship, verified_at)
       VALUES ($1::uuid, $2::uuid, 'parent', now())`,
      [userId, learnerId],
    );

    const response = await POST_ACTIVE(
      new Request("https://test/api/children/active", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ learnerRef: ref }),
      }),
    );
    expect(response.status).toBe(204);
    expect(jar.get("sk_learner")).toBe(ref);
  });
});
