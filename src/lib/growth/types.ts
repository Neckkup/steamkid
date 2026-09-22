/**
 * The growth contract, as the dashboard reads it (PRO-9).
 *
 * Every field here comes from PRO-3 `growth-definition` §8 — the shape the API
 * promises the frontend — and from the columns `app.skill_state` /
 * `app.skill_state_history` actually hold. Nothing in this file computes
 * growth. That is deliberate and it is the rule the document states twice:
 *
 *   > แดชบอร์ดอ่านจาก snapshot เท่านั้น ห้ามคำนวณสดตอน render
 *
 * The EWMA, the five mastery gates, the four efficiency gates and the validity
 * flags belong to the nightly job (Backend, PRO-7 / AIEngineer, PRO-10). If a
 * number is wrong on the screen, it is wrong in the snapshot, and there is
 * exactly one place to go and fix it. A dashboard that recomputed would give
 * the child one answer and the training set another.
 */

/** `app.skill_state.growth_label`. `insufficient_evidence` is an answer, not a failure. */
export type GrowthLabel = "improving" | "steady" | "declining" | "insufficient_evidence";

/** `app.skill_state.growth_kind`. Null while the label is not `improving`. */
export type GrowthKind = "mastery" | "efficiency" | null;

/** `app.skill.kind` — the two layers of the PRO-3 skill map. */
export type SkillKind = "cognitive" | "behaviour";

/**
 * One skill's current state for one learner.
 *
 * `skillName` is joined from `app.skill.name_th`, which is seeded from
 * `skill-map.v1.json`. The skill map forbids hard-coding the skill list in
 * application code, so the dashboard renders whatever skills the database
 * holds and has no opinion about how many there are.
 */
export interface SkillSnapshot {
  readonly skillCode: string;
  readonly skillName: string;
  readonly skillKind: SkillKind;
  /** 0–1. EWMA from the nightly job, never computed here. */
  readonly mastery: number;
  /** `m_end − m_start` over the comparison window; null when not computed. */
  readonly masteryDelta: number | null;
  /** 0–1. Below `CONFIDENCE_DISPLAY_FLOOR` the trend is not shown to a child. */
  readonly confidence: number;
  readonly assistIndex: number;
  readonly growthLabel: GrowthLabel;
  readonly growthKind: GrowthKind;
  /** `G1_mastery_gain`, `E1_less_assist`, … The teacher's way to argue with the number. */
  readonly reasonCodes: readonly string[];
  readonly evidenceCount: number;
  readonly lastEvidenceAt: string | null;
  readonly growthModelVersion: string;
  readonly computedAt: string;
}

/** One nightly snapshot of one skill — a point on the trend line. */
export interface SkillTrendPoint {
  readonly snapshotAt: string;
  readonly mastery: number;
  readonly confidence: number;
  readonly growthLabel: GrowthLabel;
}

/** Everything the two dashboards need about one learner, in one read. */
export interface LearnerGrowth {
  /** `app.learner.public_ref`. The internal id never leaves the query. */
  readonly learnerRef: string;
  readonly gradeBand: string;
  readonly skills: readonly SkillSnapshot[];
  /** Keyed by `skillCode`, oldest point first. */
  readonly trends: Readonly<Record<string, readonly SkillTrendPoint[]>>;
}

/** A row of the teacher's class list. */
export interface ClassroomEntry {
  readonly learnerRef: string;
  readonly gradeBand: string;
  /**
   * `identity.learner_profile.display_name` — the child's nickname, which the
   * PRO-3 consent/PII policy classifies as PII that never leaves our systems.
   * Null when the reader is not entitled to it, so a caller that forgets to
   * ask gets no name rather than a leaked one.
   */
  readonly displayName: string | null;
  readonly skillsTracked: number;
  readonly improving: number;
  readonly declining: number;
  readonly insufficientEvidence: number;
  /** Lowest confident mastery, used to sort the list by who needs a teacher. */
  readonly lowestMastery: number | null;
  readonly lastEvidenceAt: string | null;
}

/**
 * The display gate from `growth-definition` §3, assigned to this task by name:
 *
 *   > กฎการแสดงผล: `confidence < 0.4` ห้ามแสดงกราฟการเติบโตให้เด็กหรือผู้ปกครองเห็น
 *   > … นี่เป็นข้อกำหนดของ UI ไม่ใช่ข้อเสนอแนะ — Coder ต้อง enforce ที่ PRO-9
 *
 * It lives next to the types rather than in a component because a threshold
 * inside JSX is a threshold the next screen forgets. `present.ts` applies it
 * once, for every audience, and the pages cannot reach around it: a child's
 * view is handed a projection that has no trend line to render.
 */
export const CONFIDENCE_DISPLAY_FLOOR = 0.4;
