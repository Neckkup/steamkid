/**
 * One child, for a teacher — PRO-9, second half.
 *
 * The acceptance criterion is a stopwatch: a teacher opens this and can answer
 * "what should this child do next" within ten seconds. So the answer is the
 * first thing on the page, in a box, with the reason underneath it — and every
 * number it rests on is below, because a recommendation a teacher cannot
 * challenge is one they will stop reading.
 *
 * The behaviour signals the founder asked for (ความสม่ำเสมอ, ความพยายาม, จุดที่
 * ติดนาน) are the `BEH.*` rows: they are on this page and deliberately not on
 * the child's.
 */

import Link from "next/link";
import { notFound } from "next/navigation";

import { TrendChart } from "@/components/growth/trend-chart";
import { DemoDataNotice, NoDataNotice } from "@/components/growth/notices";
import { Card, EmptyState, PageHeading, PageShell, StatusPill } from "@/components/ui";
import { percent, presentForTeacher, type TeacherSkillRow } from "@/lib/growth/present";
import { isDemoDatabase, resolveGrowthSource } from "@/lib/growth/runtime";
import { CONFIDENCE_DISPLAY_FLOOR, type GrowthLabel } from "@/lib/growth/types";
import { isUuidV7 } from "@/lib/ids";

import { assertTeacherSurfaceAllowed } from "../guard";

export const dynamic = "force-dynamic";

const LABEL_TEXT: Record<GrowthLabel, string> = {
  improving: "ดีขึ้น",
  steady: "คงที่",
  declining: "ถดถอย",
  insufficient_evidence: "ข้อมูลไม่พอ",
};

const LABEL_TONE: Record<GrowthLabel, "correct" | "notyet" | "waiting" | "neutral"> = {
  improving: "correct",
  steady: "neutral",
  declining: "notyet",
  insufficient_evidence: "waiting",
};

function thaiDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("th-TH", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function SkillRow({ row }: { readonly row: TeacherSkillRow }) {
  const { snapshot } = row;
  return (
    <li>
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-xl font-bold leading-snug">{snapshot.skillName}</h3>
            <p className="font-mono text-sm text-muted">{snapshot.skillCode}</p>
          </div>
          <StatusPill tone={LABEL_TONE[snapshot.growthLabel]}>
            {LABEL_TEXT[snapshot.growthLabel]}
            {snapshot.growthKind ? ` · ${snapshot.growthKind}` : ""}
          </StatusPill>
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          <div>
            <dt className="text-sm text-muted">mastery</dt>
            <dd className="text-lg font-semibold">{percent(snapshot.mastery)}</dd>
          </div>
          <div>
            <dt className="text-sm text-muted">เปลี่ยนแปลง 14 วัน</dt>
            <dd className="text-lg font-semibold">
              {snapshot.masteryDelta === null
                ? "—"
                : `${snapshot.masteryDelta > 0 ? "+" : ""}${Math.round(snapshot.masteryDelta * 100)}`}
            </dd>
          </div>
          <div>
            <dt className="text-sm text-muted">ความมั่นใจ</dt>
            <dd className="text-lg font-semibold">
              {percent(snapshot.confidence)}
              {row.confident ? "" : " ⚠"}
            </dd>
          </div>
          <div>
            <dt className="text-sm text-muted">หลักฐาน</dt>
            <dd className="text-lg font-semibold">{snapshot.evidenceCount} ชิ้น</dd>
          </div>
        </dl>

        {row.confident ? null : (
          <p className="mt-3 rounded-2xl bg-waiting-soft px-4 py-2 text-base text-waiting">
            ความมั่นใจต่ำกว่า {CONFIDENCE_DISPLAY_FLOOR} — กราฟนี้ไม่ถูกแสดงให้นักเรียนและผู้ปกครองเห็น
            และไม่ควรใช้ตัดสินอะไรคนเดียว
          </p>
        )}

        {row.trend.length > 0 ? (
          <TrendChart points={row.trend} skillName={snapshot.skillName} variant="teacher" />
        ) : (
          <p className="mt-3 text-base text-muted">ยังไม่มีประวัติ snapshot ของทักษะนี้</p>
        )}

        <p className="mt-3 text-base text-muted">
          เหตุผล:{" "}
          {snapshot.reasonCodes.length > 0 ? (
            <span className="font-mono">{snapshot.reasonCodes.join(" · ")}</span>
          ) : (
            "ไม่มีรหัสเหตุผล"
          )}
        </p>
        <p className="text-base text-muted">
          หลักฐานล่าสุด {thaiDateTime(snapshot.lastEvidenceAt)} · คำนวณเมื่อ{" "}
          {thaiDateTime(snapshot.computedAt)} · {snapshot.growthModelVersion}
        </p>
      </Card>
    </li>
  );
}

export default async function TeacherLearnerPage({
  params,
}: {
  readonly params: Promise<{ learnerRef: string }>;
}) {
  assertTeacherSurfaceAllowed();

  const { learnerRef } = await params;
  // Same reason as the review screen (PRO-98 D2): `app.learner.public_ref` is
  // `uuid` with an `is_uuidv7` CHECK, so a ref of any other shape cannot name a
  // learner — but the query would cast it and Postgres would raise "invalid
  // input syntax for type uuid" all the way to the error boundary, which tells
  // a teacher the system is down when they only mistyped a link.
  if (!isUuidV7(learnerRef)) notFound();

  const source = await resolveGrowthSource();
  const demo = isDemoDatabase();

  if (!source) {
    return (
      <PageShell width="wide">
        <PageHeading title="การเติบโตรายคน" />
        <NoDataNotice audience="teacher" />
      </PageShell>
    );
  }

  const growth = await source.getLearnerGrowth(learnerRef);
  if (!growth) notFound();

  const view = presentForTeacher(growth);
  const displayName = await source.getDisplayName(learnerRef, "teacher_dashboard_learner", null);
  const name = displayName ?? `นักเรียน ${learnerRef.slice(0, 8)}`;

  return (
    <PageShell width="wide">
      <p className="mb-2">
        <Link href="/teacher" className="text-brand-strong underline underline-offset-4">
          ← กลับไปรายชื่อห้อง
        </Link>
      </p>
      <PageHeading title={name} lead={`${growth.gradeBand.toUpperCase()} · อ้างอิง ${learnerRef}`} />
      {demo ? <DemoDataNotice /> : null}

      {view.nextAction ? (
        <Card
          className={
            view.nextAction.urgency === "declining"
              ? "border-notyet bg-notyet-soft"
              : view.nextAction.urgency === "low_mastery"
                ? "border-brand bg-brand-soft"
                : "border-waiting bg-waiting-soft"
          }
        >
          <p className="text-base font-semibold uppercase tracking-wide">ควรทำอะไรต่อ</p>
          <h2 className="mt-1 text-2xl font-bold leading-snug">{view.nextAction.headline}</h2>
          <p className="mt-2">{view.nextAction.detail}</p>
        </Card>
      ) : (
        <EmptyState
          title="ยังไม่มี snapshot ของนักเรียนคนนี้"
          body="นักเรียนคนนี้ยังไม่มีงานที่ตรวจแล้วมากพอให้ระบบคำนวณการเติบโต ให้เริ่มจากมอบแบบฝึกหัดสักชุดหนึ่งก่อน"
        />
      )}

      {view.cognitive.length > 0 ? (
        <section className="mt-8">
          <h2 className="text-2xl font-bold">ทักษะเชิงความรู้</h2>
          <p className="text-muted">เรียงจากทักษะที่อ่อนที่สุดขึ้นก่อน</p>
          <ul className="mt-4 grid gap-4">
            {view.cognitive.map((row) => (
              <SkillRow key={row.snapshot.skillCode} row={row} />
            ))}
          </ul>
        </section>
      ) : null}

      {view.behaviour.length > 0 ? (
        <section className="mt-10">
          <h2 className="text-2xl font-bold">สัญญาณพฤติกรรม</h2>
          <p className="text-muted">
            คำนวณจาก event ล้วน ไม่ใช้คะแนน — และไม่แสดงให้นักเรียนเห็น
          </p>
          <ul className="mt-4 grid gap-4">
            {view.behaviour.map((row) => (
              <SkillRow key={row.snapshot.skillCode} row={row} />
            ))}
          </ul>
        </section>
      ) : null}
    </PageShell>
  );
}
