/**
 * Every id this product mints, in one place.
 *
 * PRO-17 decision 1: primary keys are UUIDv7. Postgres 17 has no native
 * `uuidv7()` — it lands in 18 — and `gen_random_uuid()` is v4, which scatters
 * inserts across every page of an index on an append-only, time-ordered table.
 * So the application mints them, and `app.uuidv7()` in the first migration is
 * the database-side twin used by migrations, seeds and fixtures.
 *
 * `uuidv7Timestamp` matters more than it looks: `events.behavior_event`
 * derives its partition key from it, and a CHECK constraint in migration 2
 * re-derives the same value in SQL. The two implementations must agree
 * exactly, which `ids.test.ts` pins.
 */

/** Injectable so tests get deterministic ids instead of a mocked global. */
export type RandomBytes = (length: number) => Uint8Array;

export const defaultRandomBytes: RandomBytes = (length) => {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
};

const HEX = Array.from({ length: 256 }, (_, index) => index.toString(16).padStart(2, "0"));

/**
 * RFC 9562 UUIDv7: 48-bit millisecond timestamp, then randomness.
 */
export function uuidv7(nowMs: number = Date.now(), randomBytes: RandomBytes = defaultRandomBytes): string {
  const bytes = new Uint8Array(16);
  const timestamp = Math.floor(nowMs);

  bytes[0] = Math.floor(timestamp / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(timestamp / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(timestamp / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(timestamp / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(timestamp / 2 ** 8) & 0xff;
  bytes[5] = timestamp & 0xff;

  bytes.set(randomBytes(10), 6);

  // version 7 in the high nibble of byte 6, RFC 4122 variant in byte 8.
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) => HEX[byte]!).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a syntactically valid UUID whose version nibble is 7. */
export function isUuidV7(value: string): boolean {
  return UUID_RE.test(value) && value[14] === "7";
}

/**
 * The embedded millisecond timestamp, or null when `value` is not a UUIDv7.
 *
 * This is what becomes `events.behavior_event.event_time`. Deriving it from the
 * id rather than trusting a client timestamp is what makes retry-safety a
 * property of the primary key instead of a property of the emitter's good
 * behaviour (data-schema §4.1).
 */
export function uuidv7Timestamp(value: string): number | null {
  if (!isUuidV7(value)) return null;
  const hex = value.replace(/-/g, "").slice(0, 12);
  return Number.parseInt(hex, 16);
}
