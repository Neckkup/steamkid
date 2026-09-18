/**
 * The wire shape of a behaviour event, and the ids that go in it.
 *
 * Deliberately absent: `learner_id`. The server derives the learner from the
 * session cookie (PRO-3 data schema, rule 1). A client that could name the
 * learner could also name a different one.
 */

export interface EventContext {
  readonly lesson_id?: string | null;
  readonly item_id?: string | null;
  readonly submission_id?: string | null;
  readonly path_step_id?: string | null;
  readonly verdict_id?: string | null;
  /** Set when this action leads to an AI call; becomes the Langfuse trace id. */
  readonly correlation_id?: string | null;
}

export interface EventEnvelope extends EventContext {
  /** Client-generated uuidv7. The server de-duplicates on it. */
  readonly event_id: string;
  /** Per-session counter. Ordering survives a wrong device clock; `occurred_at` does not. */
  readonly client_seq: number;
  readonly event_name: string;
  readonly event_version: number;
  /** Client clock. The server records its own `received_at` alongside. */
  readonly occurred_at: string;
  readonly session_id: string;
  readonly registry_version: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

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
 *
 * v7 rather than v4 because these ids are the primary key of an append-only,
 * time-partitioned table. Time-ordered keys keep inserts at the end of the
 * index instead of scattering them across every page.
 */
export function uuidv7(nowMs: number, randomBytes: RandomBytes = defaultRandomBytes): string {
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
