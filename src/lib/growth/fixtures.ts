/**
 * Synthetic learners for the growth dashboard.
 *
 * These rows are what the nightly job of `growth-definition` §7 would have
 * written: `app.skill_state` as it stands tonight, and one
 * `app.skill_state_history` row per week behind it. They are **fixture data,
 * not a second implementation of the growth model** — no EWMA, no gates, no
 * reason-code derivation happens here. Each learner is a case the dashboard has
 * to handle, written out by hand so that a test can assert what the screen
 * should say about it:
 *
 *   - `ready`    — a full picture: growth, an efficiency win, a decline, and
 *                  skills we do not have enough evidence for
 *   - `thin`     — real activity, but every skill under the §3 confidence
 *                  floor. The child must see "ยังเก็บข้อมูลไม่พอ", never a chart
 *   - `brandNew` — a learner row and nothing else, which is what a child who
 *                  signed up this morning actually looks like
 *
 * No real learner exists in this repository. Every name here is invented.
 *
 * `SKILL_MAP_FIXTURE` is a copy of PRO-3's skill map for seeding `app.skill` in
 * a throwaway database. The authority is `skill-map.v1.json`, which Backend
 * seeds from in PRO-7 — when that file lands in the repo this constant should
 * be deleted and read from it instead, exactly as `seedEventRegistry` reads
 * `event-registry.v1.json`.
 */

import type { SqlExecutor } from "@/lib/db/sql";
import { uuidv7 } from "@/lib/ids";

import type { GrowthLabel, GrowthKind } from "./types";

export const GROWTH_MODEL_VERSION = "growth-2026.09.1";
const SKILL_MAP_VERSION = "1.0.0";

export const SKILL_MAP_FIXTURE: readonly {
  code: string;
  kind: "cognitive" | "behaviour";
  nameTh: string;
}[] = [
  { code: "SCI.OBSERVE", kind: "cognitive", nameTh: "การสังเกตและบันทึกข้อมูล" },
  { code: "SCI.HYPOTHESIS", kind: "cognitive", nameTh: "การตั้งสมมติฐาน" },
  { code: "SCI.EXPLAIN_EVIDENCE", kind: "cognitive", nameTh: "การอธิบายโดยอ้างหลักฐาน" },
  { code: "SCI.CONCEPT_FORCE_MOTION", kind: "cognitive", nameTh: "แรงและการเคลื่อนที่" },
  { code: "MATH.QUANT_REASONING", kind: "cognitive", nameTh: "การใช้ตัวเลขและกราฟ" },
  { code: "CT.DECOMPOSE_SEQUENCE", kind: "cognitive", nameTh: "แตกปัญหาและเรียงลำดับขั้นตอน" },
  { code: "COMM.SCI_WRITING", kind: "cognitive", nameTh: "การเขียนอธิบายความคิด" },
  { code: "BEH.PERSISTENCE", kind: "behaviour", nameTh: "ความพยายาม ไม่ล้มเลิก" },
  { code: "BEH.SELF_REGULATION", kind: "behaviour", nameTh: "คิดก่อนตอบ ไม่เดาสุ่ม" },
  { code: "BEH.FEEDBACK_UPTAKE", kind: "behaviour", nameTh: "นำฟีดแบ็กไปใช้" },
  { code: "BEH.CONSISTENCY", kind: "behaviour", nameTh: "ความสม่ำเสมอ" },
  { code: "BEH.HELP_SEEKING", kind: "behaviour", nameTh: "ขอความช่วยเหลืออย่างเหมาะสม" },
  { code: "BEH.CONTENT_ENGAGEMENT", kind: "behaviour", nameTh: "เอาใจใส่เนื้อหา" },
  { code: "BEH.PATH_ADHERENCE", kind: "behaviour", nameTh: "ทำตามเส้นทางที่แนะนำ" },
];

export async function seedSkillMap(sql: SqlExecutor): Promise<number> {
  for (const skill of SKILL_MAP_FIXTURE) {
    await sql.query(
      `INSERT INTO app.skill (skill_code, kind, name_th, name_en, signal_spec, skill_map_version)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (skill_code) DO NOTHING`,
      [skill.code, skill.kind, skill.nameTh, skill.code, "fixture", SKILL_MAP_VERSION],
    );
  }
  return SKILL_MAP_FIXTURE.length;
}

interface SkillFixture {
  readonly code: string;
  /** Mastery tonight. */
  readonly mastery: number;
  /** Mastery 8 weeks ago, which the weekly history walks from. */
  readonly masteryStart: number;
  readonly confidence: number;
  readonly assistIndex: number;
  readonly growthDelta: number | null;
  readonly growthLabel: GrowthLabel;
  readonly growthKind: GrowthKind;
  readonly reasonCodes: readonly string[];
  readonly evidenceCount: number;
}

/**
 * The child on the front of every screenshot: enough evidence for four of the
 * seven cognitive skills, one of them slipping, two still unanswerable.
 */
const READY_SKILLS: readonly SkillFixture[] = [
  {
    code: "SCI.EXPLAIN_EVIDENCE",
    mastery: 0.62,
    masteryStart: 0.44,
    confidence: 0.75,
    assistIndex: 0.38,
    growthDelta: 0.11,
    growthLabel: "improving",
    growthKind: "mastery",
    reasonCodes: ["G1_mastery_gain", "G2_difficulty_held", "G3_assist_not_inflated", "G5_confidence_ok"],
    evidenceCount: 9,
  },
  {
    code: "COMM.SCI_WRITING",
    mastery: 0.57,
    masteryStart: 0.55,
    confidence: 0.61,
    assistIndex: 0.22,
    growthDelta: 0.01,
    growthLabel: "improving",
    growthKind: "efficiency",
    reasonCodes: ["E1_less_assist", "G5_confidence_ok"],
    evidenceCount: 8,
  },
  {
    code: "SCI.OBSERVE",
    mastery: 0.71,
    masteryStart: 0.68,
    confidence: 0.68,
    assistIndex: 0.3,
    growthDelta: 0.02,
    growthLabel: "steady",
    growthKind: null,
    reasonCodes: ["G1_below_threshold"],
    evidenceCount: 8,
  },
  {
    code: "MATH.QUANT_REASONING",
    mastery: 0.41,
    masteryStart: 0.53,
    confidence: 0.63,
    assistIndex: 0.71,
    growthDelta: -0.11,
    growthLabel: "declining",
    growthKind: null,
    reasonCodes: ["D1_mastery_drop", "D2_assist_inflated"],
    evidenceCount: 7,
  },
  {
    code: "SCI.CONCEPT_FORCE_MOTION",
    mastery: 0.66,
    masteryStart: 0.6,
    confidence: 0.52,
    assistIndex: 0.34,
    growthDelta: 0.04,
    growthLabel: "steady",
    growthKind: null,
    reasonCodes: ["G1_below_threshold"],
    evidenceCount: 6,
  },
  {
    code: "CT.DECOMPOSE_SEQUENCE",
    mastery: 0.55,
    masteryStart: 0.5,
    confidence: 0.31,
    assistIndex: 0.4,
    growthDelta: null,
    growthLabel: "insufficient_evidence",
    growthKind: null,
    reasonCodes: ["IE_lesson_diversity"],
    evidenceCount: 3,
  },
  {
    code: "SCI.HYPOTHESIS",
    mastery: 0.5,
    masteryStart: 0.5,
    confidence: 0.12,
    assistIndex: 0.5,
    growthDelta: null,
    growthLabel: "insufficient_evidence",
    growthKind: null,
    reasonCodes: ["IE_min_evidence"],
    evidenceCount: 2,
  },
  {
    code: "BEH.PERSISTENCE",
    mastery: 0.64,
    masteryStart: 0.46,
    confidence: 0.7,
    assistIndex: 0,
    growthDelta: 0.18,
    growthLabel: "improving",
    growthKind: "mastery",
    reasonCodes: ["B_index_gain"],
    evidenceCount: 11,
  },
  {
    code: "BEH.CONSISTENCY",
    mastery: 0.27,
    masteryStart: 0.48,
    confidence: 0.66,
    assistIndex: 0,
    growthDelta: -0.21,
    growthLabel: "declining",
    growthKind: null,
    reasonCodes: ["D3_consistency_low_two_windows"],
    evidenceCount: 11,
  },
  {
    code: "BEH.FEEDBACK_UPTAKE",
    mastery: 0.52,
    masteryStart: 0.33,
    confidence: 0.58,
    assistIndex: 0,
    growthDelta: 0.19,
    growthLabel: "improving",
    growthKind: "mastery",
    reasonCodes: ["B_index_gain"],
    evidenceCount: 9,
  },
  {
    code: "BEH.SELF_REGULATION",
    mastery: 0.59,
    masteryStart: 0.57,
    confidence: 0.6,
    assistIndex: 0,
    growthDelta: 0.02,
    growthLabel: "steady",
    growthKind: null,
    reasonCodes: [],
    evidenceCount: 9,
  },
  {
    code: "BEH.HELP_SEEKING",
    mastery: 0.44,
    masteryStart: 0.4,
    confidence: 0.55,
    assistIndex: 0,
    growthDelta: 0.04,
    growthLabel: "steady",
    growthKind: null,
    reasonCodes: [],
    evidenceCount: 9,
  },
];

/** Active but sparse: three skills touched once or twice, nothing conclusive. */
const THIN_SKILLS: readonly SkillFixture[] = [
  {
    code: "SCI.OBSERVE",
    mastery: 0.54,
    masteryStart: 0.5,
    confidence: 0.22,
    assistIndex: 0.45,
    growthDelta: null,
    growthLabel: "insufficient_evidence",
    growthKind: null,
    reasonCodes: ["IE_min_evidence", "IE_session_diversity"],
    evidenceCount: 3,
  },
  {
    code: "MATH.QUANT_REASONING",
    mastery: 0.47,
    masteryStart: 0.5,
    confidence: 0.14,
    assistIndex: 0.6,
    growthDelta: null,
    growthLabel: "insufficient_evidence",
    growthKind: null,
    reasonCodes: ["IE_min_evidence"],
    evidenceCount: 2,
  },
  {
    code: "BEH.PERSISTENCE",
    mastery: 0.5,
    masteryStart: 0.5,
    confidence: 0.2,
    assistIndex: 0,
    growthDelta: null,
    growthLabel: "insufficient_evidence",
    growthKind: null,
    reasonCodes: ["IE_min_evidence"],
    evidenceCount: 2,
  },
];

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const HISTORY_WEEKS = 8;

export interface SeededGrowthLearner {
  readonly learnerId: string;
  readonly publicRef: string;
  readonly displayName: string;
}

async function insertSkillState(
  sql: SqlExecutor,
  learnerId: string,
  skill: SkillFixture,
  computedAt: Date,
): Promise<void> {
  await sql.query(
    `INSERT INTO app.skill_state
       (learner_id, skill_code, mastery, confidence, evidence_count, assist_index,
        growth_label, growth_kind, growth_delta, reason_codes, last_evidence_at,
        growth_model_version, computed_at)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10::text[], $11::timestamptz, $12, $13::timestamptz)`,
    [
      learnerId,
      skill.code,
      skill.mastery,
      skill.confidence,
      skill.evidenceCount,
      skill.assistIndex,
      skill.growthLabel,
      skill.growthKind,
      skill.growthDelta,
      [...skill.reasonCodes],
      new Date(computedAt.getTime() - WEEK_MS / 7).toISOString(),
      GROWTH_MODEL_VERSION,
      computedAt.toISOString(),
    ],
  );
}

/**
 * One history row per week.
 *
 * Mastery walks from `masteryStart` to `mastery` in equal steps — a fixture
 * shape, not a model. The final point equals `app.skill_state.mastery` on
 * purpose: a chart whose last point disagrees with the headline number is the
 * first thing a teacher would (rightly) stop trusting.
 */
async function insertHistory(
  sql: SqlExecutor,
  learnerId: string,
  skill: SkillFixture,
  now: Date,
): Promise<void> {
  for (let week = HISTORY_WEEKS - 1; week >= 0; week -= 1) {
    const progress = (HISTORY_WEEKS - 1 - week) / (HISTORY_WEEKS - 1);
    const mastery = skill.masteryStart + (skill.mastery - skill.masteryStart) * progress;
    const confidence = skill.confidence * (0.55 + 0.45 * progress);
    const isLast = week === 0;
    await sql.query(
      `INSERT INTO app.skill_state_history
         (id, learner_id, skill_code, snapshot_at, mastery, confidence, assist_index,
          evidence_count, growth_label, growth_kind, growth_delta, reason_codes,
          growth_model_version)
       VALUES ($1::uuid, $2::uuid, $3, $4::timestamptz, $5, $6, $7, $8, $9, $10, $11,
               $12::text[], $13)`,
      [
        uuidv7(),
        learnerId,
        skill.code,
        new Date(now.getTime() - week * WEEK_MS).toISOString(),
        Number(mastery.toFixed(4)),
        Number(confidence.toFixed(4)),
        skill.assistIndex,
        Math.max(1, Math.round(skill.evidenceCount * (0.4 + 0.6 * progress))),
        isLast ? skill.growthLabel : progress < 0.5 ? "insufficient_evidence" : skill.growthLabel,
        isLast ? skill.growthKind : null,
        isLast ? skill.growthDelta : null,
        isLast ? [...skill.reasonCodes] : [],
        GROWTH_MODEL_VERSION,
      ],
    );
  }
}

/**
 * Create one synthetic learner and, optionally, their snapshots.
 *
 * The learner row is created directly rather than through the events fixture so
 * this module can be used on its own; guardians and consent records are not
 * needed to read a snapshot and are left out deliberately.
 */
export async function seedGrowthLearner(
  sql: SqlExecutor,
  options: {
    readonly displayName: string;
    readonly profile: "ready" | "thin" | "brandNew";
    readonly gradeBand?: string;
    readonly now?: Date;
  },
): Promise<SeededGrowthLearner> {
  const learnerId = uuidv7();
  const publicRef = uuidv7();
  const now = options.now ?? new Date();

  await sql.query(`INSERT INTO app.learner (id, public_ref, grade_band) VALUES ($1::uuid, $2::uuid, $3)`, [
    learnerId,
    publicRef,
    options.gradeBand ?? "p5",
  ]);
  await sql.query(
    `INSERT INTO identity.learner_profile (learner_id, display_name, birth_year_month)
     VALUES ($1::uuid, $2, $3::date)`,
    [learnerId, options.displayName, "2015-06-01"],
  );

  const skills =
    options.profile === "ready" ? READY_SKILLS : options.profile === "thin" ? THIN_SKILLS : [];

  for (const skill of skills) {
    await insertSkillState(sql, learnerId, skill, now);
    await insertHistory(sql, learnerId, skill, now);
  }

  return { learnerId, publicRef, displayName: options.displayName };
}

/** The three learners every demo and every dashboard test uses. */
export async function seedGrowthDemo(
  sql: SqlExecutor,
  now: Date = new Date(),
): Promise<readonly SeededGrowthLearner[]> {
  await seedSkillMap(sql);
  return [
    await seedGrowthLearner(sql, { displayName: "ใบตอง", profile: "ready", now }),
    await seedGrowthLearner(sql, { displayName: "มีนา", profile: "thin", now }),
    await seedGrowthLearner(sql, { displayName: "ภูมิ", profile: "brandNew", now }),
  ];
}
