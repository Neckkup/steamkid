/**
 * Where growth snapshots come from, as an interface.
 *
 * Same shape as `src/lib/events/sink.ts`: one port, one Postgres adapter, one
 * wiring point (`runtime.ts`). A screen never learns whether it is talking to a
 * database, and — the part that matters for this product — there is no code
 * path that invents a number when the database is not there. `getGrowthSource`
 * returns `null`, the page renders "ยังเชื่อมต่อข้อมูลไม่ได้", and nobody sees a
 * chart made of placeholders.
 */

import type { ClassroomEntry, LearnerGrowth } from "./types";

export interface ClassroomQuery {
  /**
   * Whether the caller is entitled to see children's nicknames.
   *
   * `identity.learner_profile.display_name` is PII under the PRO-3 policy, so
   * reading it is an event we record (`identity.pii_access_log`), not a join we
   * add for convenience. The default is false: a caller that has not thought
   * about it gets pseudonymous refs.
   */
  readonly revealNames?: boolean;
  /** `identity.user_account.id` of the adult reading. Null until auth lands. */
  readonly actorUserId?: string | null;
  readonly limit?: number;
}

export interface GrowthSource {
  /** Null when this learner has no row at all — a genuinely new child. */
  getLearnerGrowth(learnerRef: string): Promise<LearnerGrowth | null>;
  /** The children a teacher can open, worst-off first. */
  listClassroom(query?: ClassroomQuery): Promise<readonly ClassroomEntry[]>;
  /** The child's nickname, logged as a PII read. Null when not stored. */
  getDisplayName(learnerRef: string, purpose: string, actorUserId?: string | null): Promise<string | null>;
}

const GLOBAL_KEY = Symbol.for("steamkid.growthSource");
type GlobalWithSource = typeof globalThis & { [GLOBAL_KEY]?: GrowthSource | null };

/** Installed by a test, or by `runtime.ts` on first use. */
export function getInstalledGrowthSource(): GrowthSource | null {
  return (globalThis as GlobalWithSource)[GLOBAL_KEY] ?? null;
}

export function setGrowthSource(source: GrowthSource | null): void {
  (globalThis as GlobalWithSource)[GLOBAL_KEY] = source;
}
