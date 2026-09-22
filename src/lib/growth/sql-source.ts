/**
 * The Postgres adapter for the growth dashboard (PRO-9).
 *
 * Three properties are worth stating, because each is a rule from PRO-3 that a
 * more obvious query would have broken:
 *
 *  1. **Reads snapshots, never evidence.** Everything comes from
 *     `app.skill_state` and `app.skill_state_history`. There is no join to
 *     `app.attempt` or `app.score_effective` here, so the dashboard physically
 *     cannot start computing its own mastery the day someone is in a hurry.
 *  2. **`app.learner.id` never leaves this file.** Every public entry point
 *     takes and returns `public_ref`; the internal id is resolved inside the
 *     statement. The PII policy calls the internal id "ห้ามออกนอกระบบทุกกรณี",
 *     and the cheapest way to keep that true is never to return it.
 *  3. **Skill names come from `app.skill`.** The skill map forbids hard-coding
 *     the skill list in application code, so the screens render the rows the
 *     database has. A fifteenth skill seeded tomorrow appears with no frontend
 *     change; a skill nobody seeded shows up as its code, not as a crash.
 *
 * `SqlExecutor` rather than Prisma for the same reason the behaviour pipe uses
 * it: it is satisfied by `pg.Pool` in production and by PGlite in tests, which
 * is how `sql-source.test.ts` runs these exact statements against the real
 * migrations without a database server.
 */

import type { SqlExecutor } from "@/lib/db/sql";
import { uuidv7 } from "@/lib/ids";

import type { ClassroomQuery, GrowthSource } from "./source";
import type {
  ClassroomEntry,
  GrowthKind,
  GrowthLabel,
  LearnerGrowth,
  SkillKind,
  SkillSnapshot,
  SkillTrendPoint,
} from "./types";

/**
 * How much history the trend line covers.
 *
 * 90 days rather than the growth definition's 14-day decision window: the
 * window is what the label is computed over, the line is what a teacher reads a
 * term from. Points outside it change no number on the page.
 */
export const TREND_WINDOW_DAYS = 90;

interface SkillStateRow {
  skill_code: string;
  kind: string;
  name_th: string | null;
  mastery: string | number;
  confidence: string | number;
  assist_index: string | number;
  evidence_count: number;
  growth_label: string;
  growth_kind: string | null;
  growth_delta: string | number | null;
  reason_codes: string[] | null;
  last_evidence_at: Date | string | null;
  growth_model_version: string;
  computed_at: Date | string;
}

interface TrendRow {
  skill_code: string;
  snapshot_at: Date | string;
  mastery: string | number;
  confidence: string | number;
  growth_label: string;
}

/** Postgres `numeric` arrives as a string through both `pg` and PGlite. */
function num(value: string | number | null | undefined, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nullableNum(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * A label we do not recognise is shown as `insufficient_evidence`.
 *
 * The alternative — trusting the string — puts an unknown word in front of a
 * child. Claiming less than the row says is the safe direction to be wrong in.
 */
function label(value: string): GrowthLabel {
  return value === "improving" || value === "steady" || value === "declining"
    ? value
    : "insufficient_evidence";
}

function kind(value: string | null): GrowthKind {
  return value === "mastery" || value === "efficiency" ? value : null;
}

function skillKind(value: string): SkillKind {
  return value === "behaviour" ? "behaviour" : "cognitive";
}

export class SqlGrowthSource implements GrowthSource {
  constructor(private readonly sql: SqlExecutor) {}

  async getLearnerGrowth(learnerRef: string): Promise<LearnerGrowth | null> {
    const learner = await this.sql.query<{ id: string; grade_band: string }>(
      `SELECT id, grade_band FROM app.learner
       WHERE public_ref = $1::uuid AND status = 'active' AND deleted_at IS NULL`,
      [learnerRef],
    );
    const row = learner.rows[0];
    if (!row) return null;

    const [states, trends] = await Promise.all([
      this.sql.query<SkillStateRow>(
        `SELECT ss.skill_code, ss.mastery, ss.confidence, ss.assist_index, ss.evidence_count,
                ss.growth_label, ss.growth_kind, ss.growth_delta, ss.reason_codes,
                ss.last_evidence_at, ss.growth_model_version, ss.computed_at,
                COALESCE(s.kind, 'cognitive') AS kind, s.name_th
         FROM app.skill_state ss
         LEFT JOIN app.skill s ON s.skill_code = ss.skill_code
         WHERE ss.learner_id = $1::uuid
         ORDER BY COALESCE(s.kind, 'cognitive'), ss.skill_code`,
        [row.id],
      ),
      this.sql.query<TrendRow>(
        `SELECT skill_code, snapshot_at, mastery, confidence, growth_label
         FROM app.skill_state_history
         WHERE learner_id = $1::uuid
           AND snapshot_at >= now() - ($2 || ' days')::interval
         ORDER BY skill_code, snapshot_at`,
        [row.id, String(TREND_WINDOW_DAYS)],
      ),
    ]);

    const bySkill: Record<string, SkillTrendPoint[]> = {};
    for (const point of trends.rows) {
      (bySkill[point.skill_code] ??= []).push({
        snapshotAt: iso(point.snapshot_at) ?? "",
        mastery: num(point.mastery),
        confidence: num(point.confidence),
        growthLabel: label(point.growth_label),
      });
    }

    const skills: SkillSnapshot[] = states.rows.map((state) => ({
      skillCode: state.skill_code,
      skillName: state.name_th ?? state.skill_code,
      skillKind: skillKind(state.kind),
      mastery: num(state.mastery),
      masteryDelta: nullableNum(state.growth_delta),
      confidence: num(state.confidence),
      assistIndex: num(state.assist_index),
      growthLabel: label(state.growth_label),
      growthKind: kind(state.growth_kind),
      reasonCodes: state.reason_codes ?? [],
      evidenceCount: state.evidence_count,
      lastEvidenceAt: iso(state.last_evidence_at),
      growthModelVersion: state.growth_model_version,
      computedAt: iso(state.computed_at) ?? "",
    }));

    return { learnerRef, gradeBand: row.grade_band, skills, trends: bySkill };
  }

  /**
   * The class list.
   *
   * **There is no classroom in the schema yet.** PRO-3 `data-schema` defines
   * `app.guardian_link` but no teacher-to-learner membership, so "the class"
   * here is every active learner the nightly job has written a snapshot for.
   * That is correct for a pilot of one class and wrong the moment there are
   * two, which is why the teacher screens carry it in writing and why PRO-9's
   * handoff asks CTO and Backend for `app.classroom` / `app.classroom_member`.
   */
  async listClassroom(query: ClassroomQuery = {}): Promise<readonly ClassroomEntry[]> {
    const limit = Math.min(Math.max(query.limit ?? 60, 1), 200);

    const { rows } = await this.sql.query<{
      public_ref: string;
      learner_id: string;
      grade_band: string;
      skills_tracked: number;
      improving: number;
      declining: number;
      insufficient: number;
      lowest_mastery: string | number | null;
      last_evidence_at: Date | string | null;
    }>(
      // LEFT JOIN, not JOIN: a child who signed up this morning has no snapshot
      // and is exactly the child a teacher needs to see on this list.
      `SELECT l.public_ref, l.id AS learner_id, l.grade_band,
              COUNT(ss.skill_code)::int AS skills_tracked,
              COUNT(*) FILTER (WHERE ss.growth_label = 'improving')::int AS improving,
              COUNT(*) FILTER (WHERE ss.growth_label = 'declining')::int AS declining,
              COUNT(*) FILTER (WHERE ss.growth_label = 'insufficient_evidence')::int AS insufficient,
              -- Cognitive only: "lowest mastery" is what a teacher plans a
              -- lesson around, and a behaviour index is not a lesson.
              MIN(ss.mastery) FILTER (
                WHERE ss.growth_label <> 'insufficient_evidence'
                  AND COALESCE(s.kind, 'cognitive') = 'cognitive') AS lowest_mastery,
              MAX(ss.last_evidence_at) AS last_evidence_at
       FROM app.learner l
       LEFT JOIN app.skill_state ss ON ss.learner_id = l.id
       LEFT JOIN app.skill s ON s.skill_code = ss.skill_code
       WHERE l.status = 'active' AND l.deleted_at IS NULL
       GROUP BY l.public_ref, l.id, l.grade_band
       ORDER BY declining DESC, lowest_mastery ASC NULLS LAST, last_evidence_at DESC NULLS LAST
       LIMIT $1`,
      [limit],
    );

    const names = query.revealNames
      ? await this.readDisplayNames(
          rows.map((row) => row.learner_id),
          "teacher_dashboard_roster",
          query.actorUserId ?? null,
        )
      : new Map<string, string>();

    return rows.map((row) => ({
      learnerRef: row.public_ref,
      gradeBand: row.grade_band,
      displayName: names.get(row.learner_id) ?? null,
      skillsTracked: row.skills_tracked,
      improving: row.improving,
      declining: row.declining,
      insufficientEvidence: row.insufficient,
      lowestMastery: nullableNum(row.lowest_mastery),
      lastEvidenceAt: iso(row.last_evidence_at),
    }));
  }

  async getDisplayName(
    learnerRef: string,
    purpose: string,
    actorUserId: string | null = null,
  ): Promise<string | null> {
    const { rows } = await this.sql.query<{ id: string }>(
      `SELECT id FROM app.learner WHERE public_ref = $1::uuid AND deleted_at IS NULL`,
      [learnerRef],
    );
    const learnerId = rows[0]?.id;
    if (!learnerId) return null;

    const names = await this.readDisplayNames([learnerId], purpose, actorUserId);
    return names.get(learnerId) ?? null;
  }

  /**
   * Read nicknames, and record that we did.
   *
   * The log row is written first. If the insert fails the read does not happen,
   * which is the only ordering that makes `identity.pii_access_log` an
   * actually-complete record of who looked at a child's name rather than a
   * best-effort one.
   */
  private async readDisplayNames(
    learnerIds: readonly string[],
    purpose: string,
    actorUserId: string | null,
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (learnerIds.length === 0) return result;

    for (const learnerId of learnerIds) {
      await this.sql.query(
        `INSERT INTO identity.pii_access_log (id, actor_user_id, actor_kind, learner_id, purpose)
         VALUES ($1::uuid, $2::uuid, 'user', $3::uuid, $4)`,
        [uuidv7(), actorUserId, learnerId, purpose],
      );
    }

    const { rows } = await this.sql.query<{ learner_id: string; display_name: string }>(
      `SELECT learner_id, display_name FROM identity.learner_profile
       WHERE learner_id = ANY($1::uuid[])`,
      [learnerIds],
    );
    for (const row of rows) result.set(row.learner_id, row.display_name);
    return result;
  }
}
