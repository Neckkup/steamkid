/**
 * One answer to "which partition does this event belong in".
 *
 * `events.behavior_event` derives `event_time` from the id's first 48 bits in
 * TypeScript (`uuidv7Timestamp`, used by `pg-sink.ts`) and re-derives the same
 * value in SQL (`app.uuidv7_timestamp`, used by the
 * `behavior_event_time_derived_from_id` CHECK). If those two ever disagree, the
 * insert the sink builds is rejected by the constraint the sink is trying to
 * satisfy — and it fails on a child's device, after the gate said 202.
 *
 * So the two implementations are checked against each other here, against the
 * real function from the real migration. `ids.ts` names this file as the thing
 * that pins that agreement.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "./db/test-database";
import { defaultRandomBytes, isUuidV7, uuidv7, uuidv7Timestamp } from "./ids";

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await db.close();
});

/** `app.uuidv7_timestamp` as milliseconds, so the two are directly comparable. */
async function sqlTimestampMs(id: string): Promise<number> {
  const { rows } = await db.query<{ ms: string }>(
    `SELECT (extract(epoch from app.uuidv7_timestamp($1::uuid)) * 1000)::bigint::text AS ms`,
    [id],
  );
  return Number(rows[0]!.ms);
}

describe("uuidv7", () => {
  it("stamps the millisecond it was given", () => {
    const at = Date.parse("2026-09-19T09:00:00.000Z");
    expect(uuidv7Timestamp(uuidv7(at))).toBe(at);
  });

  it("is version 7 and RFC 4122 variant, whatever the randomness", () => {
    // All-zero and all-ones randomness are where the version and variant nibbles
    // get overwritten, so they are where a masking bug shows up.
    for (const fill of [0x00, 0xff]) {
      const id = uuidv7(Date.now(), (length) => new Uint8Array(length).fill(fill));
      expect(isUuidV7(id)).toBe(true);
      expect(id[14]).toBe("7");
      expect("89ab").toContain(id[19]!);
    }
  });

  it("sorts in time order as text, which is the point of choosing v7", () => {
    const base = Date.parse("2026-09-19T09:00:00.000Z");
    const ids = [0, 1, 2, 999, 86_400_000].map((offset) => uuidv7(base + offset));

    expect([...ids].sort()).toEqual(ids);
  });

  it("rejects a v4 id, which carries no timestamp to partition on", () => {
    const v4 = "9f1d4e2a-7c3b-4d81-9a1b-2c3d4e5f6080";
    expect(isUuidV7(v4)).toBe(false);
    expect(uuidv7Timestamp(v4)).toBeNull();
    expect(uuidv7Timestamp("not-a-uuid")).toBeNull();
  });
});

describe("uuidv7Timestamp agrees with app.uuidv7_timestamp", () => {
  it("agrees on ids minted by the application", async () => {
    const moments = [
      Date.parse("2026-01-01T00:00:00.000Z"),
      Date.parse("2026-09-19T09:00:00.000Z"),
      // A month boundary, where picking the wrong partition is silent until the
      // insert has nowhere to go.
      Date.parse("2026-09-30T23:59:59.999Z"),
      Date.parse("2026-10-01T00:00:00.000Z"),
      Date.parse("2027-12-31T23:59:59.001Z"),
    ];

    for (const at of moments) {
      const id = uuidv7(at);
      expect(uuidv7Timestamp(id)).toBe(at);
      expect(await sqlTimestampMs(id), `disagreed on ${new Date(at).toISOString()}`).toBe(at);
    }
  });

  it("agrees on ids minted by the database", async () => {
    const { rows } = await db.query<{ id: string }>(
      `SELECT app.uuidv7('2026-09-19T09:00:00Z'::timestamptz) AS id`,
    );
    const id = rows[0]!.id;

    expect(isUuidV7(id)).toBe(true);
    expect(uuidv7Timestamp(id)).toBe(Date.parse("2026-09-19T09:00:00.000Z"));
  });

  it("agrees on freshly minted random ids, not just fixed ones", async () => {
    for (let index = 0; index < 20; index += 1) {
      const id = uuidv7(Date.now(), defaultRandomBytes);
      expect(await sqlTimestampMs(id)).toBe(uuidv7Timestamp(id));
    }
  });

  it("agrees that the database's own v7 check matches ours", async () => {
    const v7 = uuidv7();
    const v4 = "9f1d4e2a-7c3b-4d81-9a1b-2c3d4e5f6080";

    const { rows } = await db.query<{ is_v7: boolean; is_v4: boolean }>(
      `SELECT app.is_uuidv7($1::uuid) AS is_v7, app.is_uuidv7($2::uuid) AS is_v4`,
      [v7, v4],
    );

    expect(rows[0]!.is_v7).toBe(isUuidV7(v7));
    expect(rows[0]!.is_v4).toBe(isUuidV7(v4));
  });
});
