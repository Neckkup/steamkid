/**
 * The dashboard's queries, against a real Postgres built from the real
 * migrations (PRO-9).
 *
 * What is actually being checked here is not "does SQL run". It is the four
 * promises the growth dashboard makes to a child, a teacher and PRO-3:
 *
 *   1. the trend line is the stored snapshot history — its last point is the
 *      number printed at the top of the card, or the chart is lying
 *   2. `confidence < 0.4` never reaches a child (`growth-definition` §3)
 *   3. a learner with no evidence gets an empty state, not a zeroed chart
 *   4. reading a child's nickname writes `identity.pii_access_log`
 *
 * Synthetic learners throughout. No real learner row exists in this repository.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/lib/db/test-database";

import { seedGrowthDemo, type SeededGrowthLearner } from "./fixtures";
import { presentForLearner, presentForTeacher } from "./present";
import { SqlGrowthSource } from "./sql-source";
import { CONFIDENCE_DISPLAY_FLOOR } from "./types";

let db: TestDatabase;
let source: SqlGrowthSource;
let ready: SeededGrowthLearner;
let thin: SeededGrowthLearner;
let brandNew: SeededGrowthLearner;

beforeAll(async () => {
  db = await createTestDatabase();
  source = new SqlGrowthSource(db);
  [ready, thin, brandNew] = await seedGrowthDemo(db);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe("reading a learner's growth", () => {
  it("returns every skill the nightly job wrote, named from app.skill", async () => {
    const growth = await source.getLearnerGrowth(ready.publicRef);

    expect(growth).not.toBeNull();
    expect(growth?.learnerRef).toBe(ready.publicRef);
    expect(growth?.skills.length).toBeGreaterThan(0);

    const explain = growth?.skills.find((s) => s.skillCode === "SCI.EXPLAIN_EVIDENCE");
    expect(explain?.skillName).toBe("การอธิบายโดยอ้างหลักฐาน");
    expect(explain?.skillKind).toBe("cognitive");
    expect(explain?.mastery).toBeCloseTo(0.62, 5);
    expect(explain?.masteryDelta).toBeCloseTo(0.11, 5);
    expect(explain?.growthLabel).toBe("improving");
    expect(explain?.growthKind).toBe("mastery");
    expect(explain?.reasonCodes).toContain("G1_mastery_gain");
    expect(explain?.growthModelVersion).toBe("growth-2026.09.1");

    const consistency = growth?.skills.find((s) => s.skillCode === "BEH.CONSISTENCY");
    expect(consistency?.skillKind).toBe("behaviour");
  });

  it("returns the stored history in order, ending on today's mastery", async () => {
    const growth = await source.getLearnerGrowth(ready.publicRef);
    const trend = growth?.trends["SCI.EXPLAIN_EVIDENCE"] ?? [];

    expect(trend.length).toBe(8);
    const times = trend.map((point) => Date.parse(point.snapshotAt));
    expect([...times]).toEqual([...times].sort((a, b) => a - b));

    // The headline number and the last point on the chart are the same number.
    const last = trend.at(-1);
    const snapshot = growth?.skills.find((s) => s.skillCode === "SCI.EXPLAIN_EVIDENCE");
    expect(last?.mastery).toBeCloseTo(snapshot?.mastery ?? -1, 4);
    expect(trend[0]?.mastery).toBeCloseTo(0.44, 4);
  });

  it("never shows a chart to a child below the confidence floor", async () => {
    const growth = await source.getLearnerGrowth(ready.publicRef);
    const view = presentForLearner(growth!);

    const shown = [...view.growing, ...view.practising, ...view.tryAgain];
    for (const card of shown) {
      const snapshot = growth!.skills.find((s) => s.skillCode === card.skillCode)!;
      expect(snapshot.confidence).toBeGreaterThanOrEqual(CONFIDENCE_DISPLAY_FLOOR);
      expect(card.trend).not.toBeNull();
    }

    for (const card of view.stillCollecting) {
      expect(card.trend).toBeNull();
    }

    // CT.DECOMPOSE_SEQUENCE has eight history rows but confidence 0.31, so the
    // data exists and the child still must not be shown a line through it.
    expect(growth!.trends["CT.DECOMPOSE_SEQUENCE"]?.length).toBe(8);
    expect(view.stillCollecting.map((c) => c.skillCode)).toContain("CT.DECOMPOSE_SEQUENCE");
  });

  it("keeps behaviour skills off the child's screen and on the teacher's", async () => {
    const growth = await source.getLearnerGrowth(ready.publicRef);
    const child = presentForLearner(growth!);
    const teacher = presentForTeacher(growth!);

    const childCodes = [
      ...child.growing,
      ...child.practising,
      ...child.tryAgain,
      ...child.stillCollecting,
    ].map((card) => card.skillCode);
    expect(childCodes.some((code) => code.startsWith("BEH."))).toBe(false);

    expect(teacher.behaviour.map((row) => row.snapshot.skillCode)).toContain("BEH.CONSISTENCY");
  });

  it("never prints the word declining on a child's card", async () => {
    const growth = await source.getLearnerGrowth(ready.publicRef);
    const child = presentForLearner(growth!);

    expect(child.tryAgain.map((card) => card.skillCode)).toContain("MATH.QUANT_REASONING");
    for (const card of child.tryAgain) {
      expect(card.headline).not.toMatch(/ถดถอย|แย่ลง|ตก/);
    }
  });

  it("answers a teacher's ten-second question with the declining skill first", async () => {
    const growth = await source.getLearnerGrowth(ready.publicRef);
    const teacher = presentForTeacher(growth!);

    expect(teacher.nextAction?.urgency).toBe("declining");
    expect(teacher.nextAction?.skillCode).toBe("MATH.QUANT_REASONING");
    expect(teacher.nextAction?.detail).toContain("D1_mastery_drop");
  });
});

describe("a learner with too little evidence", () => {
  it("tells the child we are still collecting, and shows no chart at all", async () => {
    const growth = await source.getLearnerGrowth(thin.publicRef);
    const view = presentForLearner(growth!);

    expect(view.growing).toHaveLength(0);
    expect(view.practising).toHaveLength(0);
    expect(view.tryAgain).toHaveLength(0);
    expect(view.stillCollecting.length).toBeGreaterThan(0);
    expect(view.stillCollecting.every((card) => card.trend === null)).toBe(true);
  });

  it("tells the teacher the honest reason rather than guessing a weakness", async () => {
    const growth = await source.getLearnerGrowth(thin.publicRef);
    const teacher = presentForTeacher(growth!);

    expect(teacher.nextAction?.urgency).toBe("needs_evidence");
    expect(teacher.nextAction?.detail).toContain("หลักฐาน");
  });
});

describe("a brand new learner", () => {
  it("has a row, no skills, and no invented numbers", async () => {
    const growth = await source.getLearnerGrowth(brandNew.publicRef);

    expect(growth).not.toBeNull();
    expect(growth?.skills).toHaveLength(0);
    expect(presentForLearner(growth!).hasAnySkill).toBe(false);
    expect(presentForTeacher(growth!).nextAction).toBeNull();
  });

  it("is null for a ref nobody has ever used", async () => {
    expect(await source.getLearnerGrowth("00000000-0000-7000-8000-000000000000")).toBeNull();
  });
});

describe("the class list", () => {
  it("puts the child with a decline at the top and the new child on the list", async () => {
    const roster = await source.listClassroom();

    expect(roster.map((entry) => entry.learnerRef)).toContain(brandNew.publicRef);
    expect(roster[0]?.learnerRef).toBe(ready.publicRef);
    expect(roster[0]?.declining).toBeGreaterThan(0);

    const newcomer = roster.find((entry) => entry.learnerRef === brandNew.publicRef);
    expect(newcomer?.skillsTracked).toBe(0);
    expect(newcomer?.lowestMastery).toBeNull();
  });

  it("hands back no nicknames unless asked, and logs the read when it does", async () => {
    const anonymous = await source.listClassroom();
    expect(anonymous.every((entry) => entry.displayName === null)).toBe(true);

    const before = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM identity.pii_access_log`,
    );

    const named = await source.listClassroom({ revealNames: true });
    expect(named.find((entry) => entry.learnerRef === ready.publicRef)?.displayName).toBe("ใบตอง");

    const after = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM identity.pii_access_log`,
    );
    expect(Number(after.rows[0]!.count)).toBe(Number(before.rows[0]!.count) + named.length);

    const purposes = await db.query<{ purpose: string }>(
      `SELECT DISTINCT purpose FROM identity.pii_access_log`,
    );
    expect(purposes.rows.map((row) => row.purpose)).toContain("teacher_dashboard_roster");
  });
});

describe("history is append-only", () => {
  it("refuses an UPDATE of a stored snapshot", async () => {
    // A teacher correction re-runs the model and appends (growth-definition §7).
    // If this ever started succeeding, "the chart you saw last month" would
    // stop being a fact we can reproduce.
    await expect(
      db.query(`UPDATE app.skill_state_history SET mastery = 0.99`),
    ).rejects.toThrow();
  });
});
