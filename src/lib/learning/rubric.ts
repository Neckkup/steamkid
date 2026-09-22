/**
 * Rubrics for written work — the scoring standard the AI grader is held to.
 *
 * Three ideas hold this file together, and each one exists because the
 * alternative produces a number we cannot defend:
 *
 * 1. **A criterion belongs to a skill, not to an item.** `SCI.EXPLAIN_EVIDENCE`
 *    means the same thing in lesson 1 and lesson 3, so it is described once.
 *    A per-item rubric would let the same skill drift into three definitions,
 *    and a growth chart across lessons would then be comparing three different
 *    measurements that happen to share a label.
 *
 * 2. **Levels are 0–3 ordinal, never a percentage.** A model asked for "a score
 *    out of 100" invents precision it does not have and clusters on 70/85/90.
 *    Four bands with written descriptors are what a human grader can actually
 *    reproduce, which matters because human agreement is the only number that
 *    proves this engine works.
 *
 * 3. **The item chooses its criteria, the rubric bounds them.** An item's
 *    `skillWeights` names the skills it measures; the rubric says which of them
 *    this kind of task can legitimately assess. Asking the model to score a
 *    skill the task never exercises is how a child gets marked down for not
 *    doing something nobody asked them to do.
 *
 * The prose here is Thai because it is quoted verbatim into the grading prompt
 * and, for `levels[n].childFacing`, shown to the child. A rubric a child cannot
 * read is a rubric they cannot aim at.
 */

import { isWrittenItem, type ExerciseItem, type WrittenItem } from "@/content";

/** `app.rubric.code`. One per kind of written task, not per item. */
export type RubricCode = "SCI_CER_SHORT" | "SCI_CER_LONG" | "SCI_DESIGN_LONG";

/** Skill codes from the PRO-3 skill map that written work can be scored on. */
export type WrittenSkillCode =
  | "SCI.EXPLAIN_EVIDENCE"
  | "SCI.HYPOTHESIS"
  | "SCI.CONCEPT_FORCE_MOTION"
  | "COMM.SCI_WRITING"
  | "CT.DECOMPOSE_SEQUENCE";

/** The four bands. `0` is "nothing to credit", not "wrong". */
export const RUBRIC_LEVELS = [0, 1, 2, 3] as const;
export type RubricLevel = (typeof RUBRIC_LEVELS)[number];

export interface RubricLevelDescriptor {
  readonly level: RubricLevel;
  /** What a grader looks for. Quoted into the prompt. */
  readonly descriptor: string;
}

export interface SkillCriterion {
  readonly skillCode: WrittenSkillCode;
  /** Short Thai name a teacher sees on the override screen. */
  readonly label: string;
  readonly levels: readonly RubricLevelDescriptor[];
}

/**
 * The shared criterion library.
 *
 * Level 0 is reserved for "the child did not attempt this", which is not the
 * same as attempting it and being wrong (level 1). The distinction is the whole
 * reason the band exists: a child who writes a confident wrong explanation has
 * shown us something to teach into, and a child who wrote nothing has not. A
 * scale that collapses them tells the learning path engine the same thing about
 * two children who need opposite lessons.
 */
export const SKILL_CRITERIA: Record<WrittenSkillCode, SkillCriterion> = {
  "SCI.EXPLAIN_EVIDENCE": {
    skillCode: "SCI.EXPLAIN_EVIDENCE",
    label: "ใช้หลักฐานอธิบาย",
    levels: [
      { level: 0, descriptor: "ไม่ได้อ้างถึงสิ่งที่สังเกตเห็นเลย หรือตอบไม่ตรงคำถาม" },
      {
        level: 1,
        descriptor:
          "บอกข้อสรุปหรือความเห็น แต่ไม่ได้ยกสิ่งที่สังเกตเห็นมาสนับสนุน เช่น บอกว่า 'มีแรง' เฉย ๆ",
      },
      {
        level: 2,
        descriptor:
          "ยกสิ่งที่สังเกตเห็นมาอย่างน้อยหนึ่งอย่าง แต่ยังไม่ได้เชื่อมให้ชัดว่าหลักฐานนั้นแปลว่าอะไร",
      },
      {
        level: 3,
        descriptor:
          "ยกสิ่งที่สังเกตเห็นมา และเชื่อมให้เห็นว่าหลักฐานนั้นนำไปสู่ข้อสรุปได้อย่างไร (เห็นอะไร → แปลว่าอะไร)",
      },
    ],
  },

  "SCI.HYPOTHESIS": {
    skillCode: "SCI.HYPOTHESIS",
    label: "ตั้งคำทำนายและตรวจสอบ",
    levels: [
      { level: 0, descriptor: "ไม่มีคำทำนายหรือแนวทางตรวจสอบใด ๆ" },
      {
        level: 1,
        descriptor: "บอกว่าคิดว่าอะไรจะเกิดขึ้น แต่กว้างจนตรวจสอบไม่ได้ว่าถูกหรือผิด",
      },
      {
        level: 2,
        descriptor: "คำทำนายชัดพอจะตรวจสอบได้ แต่ยังไม่บอกว่าจะรู้ได้อย่างไรว่าผลออกมาตรงหรือไม่ตรง",
      },
      {
        level: 3,
        descriptor:
          "คำทำนายชัด ตรวจสอบได้ และบอกด้วยว่าผลแบบไหนจะแปลว่าคำทำนายถูก ผลแบบไหนจะแปลว่าผิด",
      },
    ],
  },

  "SCI.CONCEPT_FORCE_MOTION": {
    skillCode: "SCI.CONCEPT_FORCE_MOTION",
    label: "ความเข้าใจเรื่องแรงและการเคลื่อนที่",
    levels: [
      { level: 0, descriptor: "ไม่ได้พูดถึงแนวคิดเรื่องแรงหรือการเคลื่อนที่เลย" },
      {
        level: 1,
        descriptor:
          "ใช้แนวคิดผิด เช่น เชื่อว่าของหนักตกเร็วกว่าเสมอ หรือเชื่อว่าของจะหยุดเองโดยไม่มีแรงมาต้าน",
      },
      {
        level: 2,
        descriptor: "ใช้แนวคิดถูกทาง แต่ยังปนความเข้าใจผิดบางส่วน หรืออธิบายได้ไม่ครบเหตุการณ์",
      },
      {
        level: 3,
        descriptor:
          "ใช้แนวคิดเรื่องแรงได้ถูกต้องกับเหตุการณ์ที่เล่า รวมถึงกรณีที่ต้องอาศัยแรงต้าน เช่น แรงเสียดทานหรือแรงต้านอากาศ",
      },
    ],
  },

  "COMM.SCI_WRITING": {
    skillCode: "COMM.SCI_WRITING",
    label: "เขียนสื่อสารให้คนอื่นเข้าใจ",
    levels: [
      { level: 0, descriptor: "สั้นหรือกระจัดกระจายจนจับใจความไม่ได้" },
      { level: 1, descriptor: "พออ่านออก แต่ลำดับความสับสน หรือผู้อ่านต้องเดาว่าหมายถึงอะไร" },
      {
        level: 2,
        descriptor: "เรียงความคิดได้เป็นลำดับ ผู้อ่านตามได้ แต่บางช่วงยังคลุมเครือหรือขาดรายละเอียด",
      },
      {
        level: 3,
        descriptor:
          "เล่าเป็นลำดับชัดเจน เลือกใช้คำให้ตรงกับสิ่งที่เกิดขึ้น และคนที่ไม่ได้อยู่ในเหตุการณ์อ่านแล้วเห็นภาพตาม",
      },
    ],
  },

  "CT.DECOMPOSE_SEQUENCE": {
    skillCode: "CT.DECOMPOSE_SEQUENCE",
    label: "ซอยงานเป็นขั้นตอน",
    levels: [
      { level: 0, descriptor: "ไม่มีขั้นตอนใด ๆ" },
      { level: 1, descriptor: "บอกสิ่งที่จะทำรวม ๆ เป็นก้อนเดียว ยังแยกเป็นขั้นตอนไม่ได้" },
      {
        level: 2,
        descriptor: "แยกเป็นขั้นตอนได้ แต่ขั้นตอนขาดหายบางช่วง หรือสลับลำดับจนทำตามจริงไม่ได้",
      },
      {
        level: 3,
        descriptor: "แยกเป็นขั้นตอนที่คนอื่นหยิบไปทำตามได้จริง เรียงลำดับถูก และไม่ข้ามขั้นสำคัญ",
      },
    ],
  },
};

export interface Rubric {
  readonly code: RubricCode;
  /**
   * `app.rubric_version.version`. Bumped whenever a level descriptor changes,
   * because a score produced under one wording is not comparable to a score
   * produced under another. It rides on every trace as `rubricVersion`.
   */
  readonly version: number;
  readonly title: string;
  /** Skills this kind of task is allowed to be scored on. */
  readonly appliesTo: readonly WrittenSkillCode[];
  /** Task-shape guidance for the grader, quoted into the prompt. */
  readonly graderGuidance: readonly string[];
}

export const RUBRICS: Record<RubricCode, Rubric> = {
  SCI_CER_SHORT: {
    code: "SCI_CER_SHORT",
    version: 1,
    title: "อธิบายสั้น ๆ ด้วยหลักฐาน",
    appliesTo: ["SCI.EXPLAIN_EVIDENCE", "SCI.HYPOTHESIS", "COMM.SCI_WRITING"],
    graderGuidance: [
      "งานนี้ขอคำตอบสั้น ไม่กี่ประโยค ความสั้นจึงไม่ใช่ข้อเสียในตัวมันเอง",
      "ถ้าใจความครบตามเกณฑ์แล้ว อย่าหักคะแนนเพราะเด็กไม่ได้เขียนยาว",
      "สะกดผิดหรือเว้นวรรคผิดไม่ใช่เหตุให้ลดระดับ ถ้ายังอ่านแล้วเข้าใจว่าเด็กหมายถึงอะไร",
    ],
  },

  SCI_CER_LONG: {
    code: "SCI_CER_LONG",
    version: 1,
    title: "อธิบายยาวด้วยข้อสรุป หลักฐาน และเหตุผล",
    appliesTo: [
      "SCI.EXPLAIN_EVIDENCE",
      "SCI.CONCEPT_FORCE_MOTION",
      "COMM.SCI_WRITING",
    ],
    graderGuidance: [
      "งานนี้ขอให้เด็กเล่าเป็นเรื่องเป็นราว จึงดูได้ทั้งความถูกต้องของแนวคิดและความชัดของการเล่า",
      "เด็กไม่จำเป็นต้องใช้คำว่า 'ข้อสรุป' หรือ 'หลักฐาน' ให้ดูที่ว่าเขาทำสิ่งนั้นหรือไม่ ไม่ใช่ว่าเขาเรียกชื่อมันถูกไหม",
      "ถ้าเด็กเล่าเหตุการณ์จริงของตัวเองที่ต่างจากตัวอย่างในบทเรียน นั่นคือข้อดี ไม่ใช่การออกนอกเรื่อง",
    ],
  },

  SCI_DESIGN_LONG: {
    code: "SCI_DESIGN_LONG",
    version: 1,
    title: "ออกแบบการทดลองของตัวเอง",
    appliesTo: ["SCI.HYPOTHESIS", "CT.DECOMPOSE_SEQUENCE", "COMM.SCI_WRITING"],
    graderGuidance: [
      "งานนี้วัดการออกแบบ ไม่ได้วัดว่าเด็กทำการทดลองจริงแล้วหรือยัง",
      "ให้ความสำคัญกับสามอย่าง: จะเปลี่ยนอะไร จะทำอะไรให้เหมือนเดิม และจะวัดอย่างไร",
      "แผนที่ทำได้จริงด้วยของในบ้านถือว่าดี ไม่ต้องเป็นอุปกรณ์ห้องทดลอง",
    ],
  },
};

export function isRubricCode(value: string): value is RubricCode {
  return value in RUBRICS;
}

/** `rubricVersion` as `data-schema` §5 wants it on a trace. */
export function rubricVersionTag(rubric: Rubric): string {
  return `${rubric.code}@${rubric.version}`;
}

export interface ResolvedRubric {
  readonly rubric: Rubric;
  /**
   * The criteria this item is actually scored on, with the item's own weight
   * attached. Ordered by descending weight so the prompt puts what matters most
   * first, and so a truncated feedback string loses the least important part.
   */
  readonly criteria: readonly { criterion: SkillCriterion; weight: number }[];
}

/**
 * Intersect an item's `skillWeights` with what its rubric can assess.
 *
 * A skill on the item that the rubric does not cover is a content authoring
 * error, not something to paper over: it means an item claims to measure
 * something its task type cannot show. Throwing here surfaces it when the
 * content is written, rather than producing a verdict that silently scores a
 * child on fewer skills than their growth chart promises.
 */
export function resolveRubric(item: WrittenItem): ResolvedRubric {
  if (!isRubricCode(item.rubricCode)) {
    throw new Error(
      `Item ${item.id} names rubric "${item.rubricCode}", which is not in RUBRICS. ` +
        `Add it to src/lib/learning/rubric.ts or fix the content.`,
    );
  }

  const rubric = RUBRICS[item.rubricCode];
  const criteria: { criterion: SkillCriterion; weight: number }[] = [];

  for (const [skillCode, weight] of Object.entries(item.skillWeights)) {
    if (!rubric.appliesTo.includes(skillCode as WrittenSkillCode)) {
      throw new Error(
        `Item ${item.id} is weighted on ${skillCode}, but rubric ${rubric.code} does ` +
          `not assess it (it assesses ${rubric.appliesTo.join(", ")}). Either the item ` +
          `has the wrong rubric or the rubric is missing a criterion.`,
      );
    }
    criteria.push({ criterion: SKILL_CRITERIA[skillCode as WrittenSkillCode], weight });
  }

  if (criteria.length === 0) {
    throw new Error(`Item ${item.id} has no skillWeights, so there is nothing to grade it on.`);
  }

  criteria.sort((a, b) => b.weight - a.weight);
  return { rubric, criteria };
}

/** Every written item in the content, checked against its rubric. */
export function assertRubricsResolve(items: readonly ExerciseItem[]): void {
  for (const item of items) {
    if (isWrittenItem(item)) resolveRubric(item);
  }
}
