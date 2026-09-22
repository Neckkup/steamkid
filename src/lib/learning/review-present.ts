/**
 * The words the teacher review screens use (PRO-77).
 *
 * Separate from the components for one reason: the three verdict statuses must
 * be described in three visibly different ways, and keeping the three strings
 * side by side in one table is what stops them drifting back together. "AI ไม่
 * ยอมตรวจ" and "AI ให้ 0" are the same pixels and opposite facts; a child who
 * is handed the second one for a system fault has been failed by us.
 *
 * Level descriptors are deliberately *not* here. They come from `SKILL_CRITERIA`
 * in `rubric.ts`, which is what the grading prompt quotes, so a rubric version
 * bump moves the prompt and the screen together. A second copy in the UI would
 * leave a teacher reading last month's standard while the model applied this
 * month's.
 */

import { SKILL_CRITERIA, type RubricLevel, type WrittenSkillCode } from "./rubric";
import type { CorrectionReasonCode, UnscorableReason, VerdictStatus } from "./verdict-store";

function knownSkill(skillCode: string): WrittenSkillCode | null {
  return skillCode in SKILL_CRITERIA ? (skillCode as WrittenSkillCode) : null;
}

/**
 * The teacher-facing Thai name of a skill.
 *
 * Falls back to the raw code rather than to a guess: a verdict can legitimately
 * carry a skill this build's rubric does not know (the levels were stored under
 * an older one), and inventing a friendly name for it would hide exactly the
 * mismatch a teacher needs to see.
 */
export function skillLabel(skillCode: string): string {
  const known = knownSkill(skillCode);
  return known ? SKILL_CRITERIA[known].label : skillCode;
}

/** What level `n` means for this skill, straight out of the rubric. */
export function levelDescriptor(skillCode: string, level: RubricLevel): string | null {
  const known = knownSkill(skillCode);
  if (!known) return null;
  return SKILL_CRITERIA[known].levels.find((entry) => entry.level === level)?.descriptor ?? null;
}

/** Every level of one skill, for the override control. */
export function levelChoices(
  skillCode: string,
): readonly { readonly level: RubricLevel; readonly descriptor: string | null }[] {
  const known = knownSkill(skillCode);
  if (known) return SKILL_CRITERIA[known].levels.map((l) => ({ level: l.level, descriptor: l.descriptor }));
  return ([0, 1, 2, 3] as const).map((level) => ({ level, descriptor: null }));
}

export interface StatusCopy {
  /** One short phrase for a queue row. */
  readonly pill: string;
  readonly tone: "correct" | "notyet" | "waiting" | "neutral";
  /** `Card`'s palette, which has no `neutral`. */
  readonly cardTone: "plain" | "brand" | "correct" | "notyet" | "waiting";
  /** The headline on the detail page. */
  readonly title: string;
  /** What actually happened, for a teacher. */
  readonly body: string;
  /** What the child is being shown meanwhile. */
  readonly learnerSees: string;
}

/**
 * Three statuses, three sets of words, no shared "คะแนน".
 *
 * Only `graded` is allowed to use the word "คะแนน" at all. The other two say
 * what happened to the *check*, never what the child scored, because the
 * honest answer to "what did they score" is "we do not know yet".
 */
export const STATUS_COPY: Record<VerdictStatus, StatusCopy> = {
  graded: {
    pill: "AI ตรวจแล้ว",
    tone: "neutral",
    cardTone: "brand",
    title: "AI ตรวจแล้ว — ครูแก้ระดับได้ทุกทักษะ",
    body: "ระดับข้างล่างนี้เป็นข้อเสนอของ AI ไม่ใช่ผลสุดท้าย ครูเปลี่ยนทีละทักษะได้ และระดับที่ครูให้จะไปแทนของ AI ทันที",
    learnerSees: "เด็กเห็นผลและคำแนะนำจาก AI แล้ว",
  },
  blocked_by_safety: {
    pill: "AI ไม่ยอมตรวจ",
    tone: "notyet",
    cardTone: "notyet",
    title: "AI ไม่ยอมตรวจงานชิ้นนี้ — ยังไม่มีคะแนน",
    body: "ตัวกรองความปลอดภัยของโมเดลหยุดการตรวจไว้ นี่ไม่ใช่ 0 คะแนน และไม่ได้แปลว่าเด็กทำผิด แปลว่าระบบยังไม่ได้ตรวจ ต้องให้ครูอ่านเอง",
    learnerSees: "เด็กเห็นข้อความว่า “ส่งให้ครูดูแล้ว” ไม่เห็นคะแนนและไม่เห็นเหตุผลของโมเดล",
  },
  unscorable: {
    pill: "ตรวจไม่ได้",
    tone: "waiting",
    cardTone: "waiting",
    title: "AI ยังตรวจงานชิ้นนี้ไม่ได้ — ยังไม่มีคะแนน",
    body: "โมเดลอ่านคำตอบแล้วแต่ให้ระดับไม่ได้ ไม่ใช่ 0 คะแนน เหตุผลอยู่ข้างล่าง ครูตัดสินได้ว่าจะให้เด็กทำใหม่หรือจะอ่านเอง",
    learnerSees: "เด็กเห็นข้อความว่า “ส่งให้ครูดูแล้ว” ไม่เห็นคะแนน",
  },
};

export const UNSCORABLE_COPY: Record<UnscorableReason, string> = {
  too_short: "คำตอบสั้นเกินกว่าจะให้ระดับได้",
  off_topic: "คำตอบไม่ตรงกับคำถามของข้อนี้",
  unparseable: "อ่านคำตอบไม่ออก หรือรูปแบบผิดไปจากที่รับได้",
};

/** The five codes `POST /api/verdicts/:id/override` accepts, in Thai. */
export const REASON_CODES: readonly {
  readonly code: CorrectionReasonCode;
  readonly label: string;
}[] = [
  { code: "too_harsh", label: "AI ให้ระดับต่ำเกินไป" },
  { code: "too_lenient", label: "AI ให้ระดับสูงเกินไป" },
  { code: "missed_criterion", label: "AI มองข้ามสิ่งที่เด็กทำได้/ทำไม่ได้" },
  { code: "wrong_reasoning", label: "ระดับพอได้ แต่เหตุผลของ AI ผิด" },
  { code: "other", label: "อื่น ๆ" },
];

export function reasonCodeLabel(code: CorrectionReasonCode): string {
  return REASON_CODES.find((entry) => entry.code === code)?.label ?? code;
}

/** `0.62` → `"62%"`. A verdict with no score has no percentage, only a dash. */
export function scoreText(normalizedScore: number | null): string {
  return normalizedScore === null ? "—" : `${Math.round(normalizedScore * 100)}%`;
}

const DAY_MS = 86_400_000;

/** "วันนี้" / "เมื่อวาน" / "3 วันก่อน" — how long a child has been waiting. */
export function waitedFor(isoDate: string): string {
  const days = Math.floor((Date.now() - Date.parse(isoDate)) / DAY_MS);
  if (!Number.isFinite(days) || days <= 0) return "วันนี้";
  if (days === 1) return "เมื่อวาน";
  return `${days} วันก่อน`;
}
