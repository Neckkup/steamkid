/**
 * Turning one snapshot into the two things two very different people need.
 *
 * A child and a teacher are not looking at the same screen with different CSS.
 * The child asks "am I getting better, and what do I do now"; the teacher asks
 * "which of these thirty children needs me first, and why". So the projection
 * happens here, in one tested place, rather than in two page components that
 * would drift apart by the second sprint.
 *
 * Two rules are enforced here rather than trusted to the markup:
 *
 *  1. **`confidence < 0.4` hides the trend from the child** (`growth-definition`
 *     §3). `presentForLearner` does not attach a trend to a low-confidence
 *     skill at all, so a page cannot render one by forgetting a condition.
 *  2. **A child is never shown a decline as a decline** (§5.4: the
 *     falling-off signal "ส่งถึงครูก่อน ไม่ต้องแสดงให้เด็กเห็น"). The same row
 *     that reads `กำลังจะเลิกเรียน` on the teacher's screen reads
 *     `มาลองเรื่องนี้ด้วยกันอีกที` on the child's, with no arrow pointing down.
 *
 * What this file does **not** do is decide whether a child grew. Every label,
 * delta and reason code is read from the snapshot as-is. The only judgement
 * added is *ordering* — which skill a teacher should look at first — and that
 * is a sort over fields the nightly job already computed, not a new formula.
 */

import {
  CONFIDENCE_DISPLAY_FLOOR,
  type LearnerGrowth,
  type SkillSnapshot,
  type SkillTrendPoint,
} from "./types";

/** A skill as a ten-year-old should meet it: one heading, one next step, no jargon. */
export interface LearnerSkillCard {
  readonly skillCode: string;
  readonly skillName: string;
  readonly headline: string;
  readonly body: string;
  readonly mastery: number;
  /** Null whenever the child is not allowed to see a trend for this skill. */
  readonly trend: readonly SkillTrendPoint[] | null;
}

export interface LearnerView {
  /** Skills that grew. The first thing on the page, always. */
  readonly growing: readonly LearnerSkillCard[];
  /** Steady: being practised, nothing wrong. */
  readonly practising: readonly LearnerSkillCard[];
  /** Worth another go. Never called a decline, never coloured like a failure. */
  readonly tryAgain: readonly LearnerSkillCard[];
  /** Not enough evidence, or not enough confidence to show a line. */
  readonly stillCollecting: readonly LearnerSkillCard[];
  /** False when this learner has no snapshot at all — the new-child empty state. */
  readonly hasAnySkill: boolean;
}

export type TeacherUrgency = "declining" | "low_mastery" | "needs_evidence";

/** The one line a teacher should be able to read in ten seconds. */
export interface TeacherNextAction {
  readonly skillCode: string;
  readonly skillName: string;
  readonly urgency: TeacherUrgency;
  readonly headline: string;
  readonly detail: string;
}

export interface TeacherSkillRow {
  readonly snapshot: SkillSnapshot;
  readonly trend: readonly SkillTrendPoint[];
  /** Teachers see the line even when it is thin; the caption says how thin. */
  readonly confident: boolean;
}

export interface TeacherView {
  readonly learnerRef: string;
  readonly gradeBand: string;
  readonly nextAction: TeacherNextAction | null;
  readonly cognitive: readonly TeacherSkillRow[];
  readonly behaviour: readonly TeacherSkillRow[];
  readonly hasAnySkill: boolean;
}

function trendOf(growth: LearnerGrowth, skillCode: string): readonly SkillTrendPoint[] {
  return growth.trends[skillCode] ?? [];
}

/**
 * Is this skill's trend allowed in front of a child or a guardian?
 *
 * Both halves matter. Confidence is the §3 gate. `insufficient_evidence` is the
 * §5.1 answer, and drawing a line under it would be showing the shape of five
 * points we already said we do not trust.
 */
export function isTrendVisibleToLearner(snapshot: SkillSnapshot): boolean {
  return (
    snapshot.confidence >= CONFIDENCE_DISPLAY_FLOOR &&
    snapshot.growthLabel !== "insufficient_evidence"
  );
}

const GROWING_BODY: Record<string, string> = {
  mastery: "หนูทำโจทย์ที่ยากขึ้นได้ดีขึ้นจริง ๆ ไม่ใช่เพราะโจทย์ง่ายลงนะ",
  efficiency: "หนูทำได้เท่าเดิมโดยใช้ตัวช่วยน้อยลง นั่นแปลว่าหนูเก่งขึ้น",
};

function learnerCard(
  snapshot: SkillSnapshot,
  growth: LearnerGrowth,
  headline: string,
  body: string,
): LearnerSkillCard {
  return {
    skillCode: snapshot.skillCode,
    skillName: snapshot.skillName,
    headline,
    body,
    mastery: snapshot.mastery,
    trend: isTrendVisibleToLearner(snapshot) ? trendOf(growth, snapshot.skillCode) : null,
  };
}

/**
 * The child's view.
 *
 * Behaviour skills (`BEH.*`) are left out on purpose. "ความสม่ำเสมอ 0.42" is a
 * measurement of a child made for an adult; handing it back to the child turns
 * the product into something that watches them. The teacher gets those rows.
 */
export function presentForLearner(growth: LearnerGrowth): LearnerView {
  const cognitive = growth.skills.filter((skill) => skill.skillKind === "cognitive");

  const growing: LearnerSkillCard[] = [];
  const practising: LearnerSkillCard[] = [];
  const tryAgain: LearnerSkillCard[] = [];
  const stillCollecting: LearnerSkillCard[] = [];

  for (const snapshot of cognitive) {
    if (!isTrendVisibleToLearner(snapshot)) {
      stillCollecting.push(
        learnerCard(
          snapshot,
          growth,
          "ยังเก็บข้อมูลไม่พอ",
          "ทำแบบฝึกหัดเรื่องนี้อีกสักหน่อย แล้วเราจะบอกได้ว่าหนูเก่งขึ้นแค่ไหน",
        ),
      );
      continue;
    }

    if (snapshot.growthLabel === "improving") {
      growing.push(
        learnerCard(
          snapshot,
          growth,
          "หนูเก่งขึ้น",
          GROWING_BODY[snapshot.growthKind ?? ""] ?? "หนูทำเรื่องนี้ได้ดีขึ้นกว่าเมื่อก่อน",
        ),
      );
    } else if (snapshot.growthLabel === "declining") {
      // §5.4 — the word "ถดถอย" and the downward arrow stop here.
      tryAgain.push(
        learnerCard(
          snapshot,
          growth,
          "มาลองเรื่องนี้อีกที",
          "ช่วงนี้เรื่องนี้ยังไม่ค่อยลงตัว ลองทำอีกสักข้อสองข้อ แล้วค่อย ๆ ไปด้วยกัน",
        ),
      );
    } else {
      practising.push(
        learnerCard(
          snapshot,
          growth,
          "กำลังฝึกอยู่",
          "หนูทำได้พอ ๆ กับช่วงที่ผ่านมา ฝึกต่ออีกนิดเดียวก็ขยับแล้ว",
        ),
      );
    }
  }

  return {
    growing,
    practising,
    tryAgain,
    stillCollecting,
    hasAnySkill: growth.skills.length > 0,
  };
}

/**
 * The one skill a child should practise next.
 *
 * The lowest-mastery cognitive skill we are confident about — and `null` when
 * there is no such skill, which is the honest answer for a child who has not
 * done enough for us to have an opinion. It is a ranking of stored snapshot
 * fields, not a recommendation: PRO-10's learning path engine owns real
 * recommendations, and when `app.learning_path_step` has rows the screen should
 * read those instead and fire `path.step_offered` with them.
 */
export function learnerFocusSkill(growth: LearnerGrowth): SkillSnapshot | null {
  const candidates = growth.skills
    .filter((skill) => skill.skillKind === "cognitive" && isTrendVisibleToLearner(skill))
    .sort((a, b) => a.mastery - b.mastery);
  return candidates[0] ?? null;
}

const URGENCY_RANK: Record<TeacherUrgency, number> = {
  declining: 0,
  low_mastery: 1,
  needs_evidence: 2,
};

/**
 * "What should this child do next?" — answered from the snapshot, by ranking.
 *
 * The ordering rule, so it can be argued with rather than reverse-engineered:
 *
 *   1. a confident `declining` skill, worst delta first — the child is losing
 *      ground on something we are sure about
 *   2. otherwise the confident skill with the lowest mastery
 *   3. otherwise the skill closest to having enough evidence, because the
 *      honest next action is "get this child to do more work here", not a
 *      recommendation built on §5.1 evidence we already rejected
 *
 * This is a sort, not a growth calculation. The moment PRO-10's learning path
 * engine writes `app.learning_path_step`, that becomes the source for this card
 * and this function turns into the fallback for a learner with no path yet.
 */
export function teacherNextAction(growth: LearnerGrowth): TeacherNextAction | null {
  const candidates = growth.skills
    .filter((skill) => skill.skillKind === "cognitive")
    .map((snapshot) => {
      const confident = snapshot.confidence >= CONFIDENCE_DISPLAY_FLOOR;
      const usable = confident && snapshot.growthLabel !== "insufficient_evidence";
      const urgency: TeacherUrgency = !usable
        ? "needs_evidence"
        : snapshot.growthLabel === "declining"
          ? "declining"
          : "low_mastery";
      return { snapshot, urgency };
    })
    .sort((a, b) => {
      const byUrgency = URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency];
      if (byUrgency !== 0) return byUrgency;
      if (a.urgency === "declining") {
        return (a.snapshot.masteryDelta ?? 0) - (b.snapshot.masteryDelta ?? 0);
      }
      if (a.urgency === "low_mastery") return a.snapshot.mastery - b.snapshot.mastery;
      // Closest to the §5.1 bar first: the cheapest one to make answerable.
      return b.snapshot.evidenceCount - a.snapshot.evidenceCount;
    });

  const top = candidates[0];
  if (!top) return null;

  const { snapshot, urgency } = top;
  const detail =
    urgency === "declining"
      ? `คะแนนทักษะนี้ลดลง ${formatDelta(snapshot.masteryDelta)} ใน 14 วันล่าสุด` +
        ` (${reasonSummary(snapshot)})`
      : urgency === "low_mastery"
        ? `ทักษะนี้ต่ำสุดในบรรดาที่ข้อมูลพอเชื่อถือได้ (mastery ${percent(snapshot.mastery)})` +
          ` — ให้ทำแบบฝึกหัดที่ติดแท็กทักษะนี้ต่อ`
        : `ยังมีหลักฐานแค่ ${snapshot.evidenceCount} ชิ้น ยังตัดสินไม่ได้ว่าโตหรือไม่` +
          ` — ต้องให้ทำงานเพิ่มก่อน ไม่ใช่สรุปว่าไม่โต`;

  return {
    skillCode: snapshot.skillCode,
    skillName: snapshot.skillName,
    urgency,
    headline:
      urgency === "declining"
        ? `ดูแลเรื่อง “${snapshot.skillName}” ก่อน`
        : urgency === "low_mastery"
          ? `ให้ฝึกเรื่อง “${snapshot.skillName}” ต่อ`
          : `ยังตัดสิน “${snapshot.skillName}” ไม่ได้`,
    detail,
  };
}

export function presentForTeacher(growth: LearnerGrowth): TeacherView {
  const rows = (kind: SkillSnapshot["skillKind"]): TeacherSkillRow[] =>
    growth.skills
      .filter((skill) => skill.skillKind === kind)
      .map((snapshot) => ({
        snapshot,
        trend: trendOf(growth, snapshot.skillCode),
        confident: snapshot.confidence >= CONFIDENCE_DISPLAY_FLOOR,
      }))
      .sort((a, b) => a.snapshot.mastery - b.snapshot.mastery);

  return {
    learnerRef: growth.learnerRef,
    gradeBand: growth.gradeBand,
    nextAction: teacherNextAction(growth),
    cognitive: rows("cognitive"),
    behaviour: rows("behaviour"),
    hasAnySkill: growth.skills.length > 0,
  };
}

export function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function formatDelta(delta: number | null): string {
  if (delta === null) return "—";
  const points = Math.round(Math.abs(delta) * 100);
  return `${points} จุด`;
}

/** Reason codes joined for a caption. Kept raw — a teacher needs the real code. */
export function reasonSummary(snapshot: SkillSnapshot): string {
  return snapshot.reasonCodes.length > 0 ? snapshot.reasonCodes.join(", ") : "ไม่มีรหัสเหตุผล";
}
