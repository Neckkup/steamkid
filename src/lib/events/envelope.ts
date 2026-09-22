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

/**
 * Ids live in `src/lib/ids.ts` (PRO-17 decision 1).
 *
 * They were defined here first, when only the browser tracker needed them.
 * They moved once the ingest side had to derive `event_time` from the same
 * bytes: two implementations of UUIDv7 would be two answers to "which
 * partition does this event belong in", and the database now has a CHECK that
 * insists on one. Re-exported so the tracker's imports stay put.
 */
export {
  defaultRandomBytes,
  isUuidV7,
  uuidv7,
  uuidv7Timestamp,
  type RandomBytes,
} from "@/lib/ids";
