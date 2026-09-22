/**
 * The teacher's class list — PRO-9, first half.
 *
 * Sorted so the top row is the child who needs a teacher most: declines first,
 * then the lowest confident mastery. A teacher opening this on a phone between
 * classes should be able to read the first row and stop.
 *
 * Two limits are on the screen rather than in a comment, because both change
 * what a teacher should conclude:
 *
 *   - **there is no classroom in the schema yet**, so this lists every learner
 *     with a snapshot rather than "your class" (handoff to CTO/Backend)
 *   - **there is no teacher sign-in yet** (PRO-12), so the page refuses to
 *     render in production rather than exposing children's nicknames to anyone
 *     who guesses the URL
 */

import Link from "next/link";

import { DemoDataNotice, NoDataNotice } from "@/components/growth/notices";
import { ButtonLink, Card, EmptyState, PageHeading, PageShell, StatusPill } from "@/components/ui";
import { percent } from "@/lib/growth/present";
import { isDemoDatabase, resolveGrowthSource } from "@/lib/growth/runtime";
import type { ClassroomEntry } from "@/lib/growth/types";

import { assertTeacherSurfaceAllowed } from "./guard";

export const dynamic = "force-dynamic";

function lastSeen(iso: string | null): string {
  if (!iso) return "ยังไม่มีงานที่ตรวจแล้ว";
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (days <= 0) return "มีงานวันนี้";
  if (days === 1) return "งานล่าสุดเมื่อวาน";
  return `งานล่าสุด ${days} วันก่อน`;
}

function LearnerRow({ entry }: { readonly entry: ClassroomEntry }) {
  const name = entry.displayName ?? `นักเรียน ${entry.learnerRef.slice(0, 8)}`;
  return (
    <li>
      <Link
        href={`/teacher/${entry.learnerRef}`}
        className="block rounded-3xl border border-line bg-surface p-5 transition-colors hover:border-brand hover:bg-brand-soft"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold">{name}</h2>
            <p className="text-base text-muted">
              {entry.gradeBand.toUpperCase()} · {lastSeen(entry.lastEvidenceAt)}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {entry.declining > 0 ? (
              <StatusPill tone="notyet">ถดถอย {entry.declining}</StatusPill>
            ) : null}
            {entry.improving > 0 ? (
              <StatusPill tone="correct">ดีขึ้น {entry.improving}</StatusPill>
            ) : null}
            {entry.skillsTracked === 0 ? (
              <StatusPill tone="waiting">ยังไม่มีข้อมูล</StatusPill>
            ) : entry.insufficientEvidence > 0 ? (
              <StatusPill tone="waiting">ข้อมูลไม่พอ {entry.insufficientEvidence}</StatusPill>
            ) : null}
          </div>
        </div>
        <p className="mt-3 text-base text-muted">
          {entry.lowestMastery === null
            ? "ยังไม่มีทักษะที่ข้อมูลพอจะสรุปได้"
            : `ทักษะที่อ่อนที่สุดที่เชื่อถือได้: ${percent(entry.lowestMastery)}`}
          {" · "}
          {entry.skillsTracked} ทักษะที่มี snapshot
        </p>
      </Link>
    </li>
  );
}

export default async function TeacherClassPage() {
  assertTeacherSurfaceAllowed();

  const source = await resolveGrowthSource();
  const demo = isDemoDatabase();

  if (!source) {
    return (
      <PageShell width="wide">
        <PageHeading title="ห้องเรียนของฉัน" />
        <NoDataNotice audience="teacher" />
      </PageShell>
    );
  }

  const roster = await source.listClassroom({ revealNames: true, actorUserId: null });

  return (
    <PageShell width="wide">
      <PageHeading
        title="ห้องเรียนของฉัน"
        lead="เรียงตามคนที่ควรดูก่อน: ถดถอยขึ้นก่อน แล้วตามด้วยทักษะที่อ่อนที่สุด"
      />
      {demo ? <DemoDataNotice /> : null}

      <Card tone="brand" className="mb-6">
        <h2 className="text-xl font-bold">งานที่รอครูดู</h2>
        <p className="mt-1 text-base text-muted">
          ชิ้นที่ AI ตรวจไม่ได้หรือไม่ยอมตรวจ เด็กยังไม่ได้ผลกลับไปเลย
        </p>
        <ButtonLink href="/teacher/review" className="mt-4">
          เปิดรายการที่รอตรวจ
        </ButtonLink>
      </Card>

      {roster.length === 0 ? (
        <EmptyState
          title="ยังไม่มีนักเรียนในระบบ"
          body="เมื่อมีนักเรียนเริ่มทำแบบฝึกหัดและระบบคำนวณ snapshot รอบกลางคืนแล้ว รายชื่อจะขึ้นที่นี่"
        />
      ) : (
        <ul className="grid gap-4">
          {roster.map((entry) => (
            <LearnerRow key={entry.learnerRef} entry={entry} />
          ))}
        </ul>
      )}

      <Card className="mt-8 border-waiting bg-waiting-soft">
        <h2 className="text-xl font-bold">ข้อจำกัดของหน้านี้ตอนนี้</h2>
        <ul className="mt-2 grid gap-2">
          <li>
            • ยังไม่มีตาราง “ห้องเรียน” ใน schema (PRO-3 data-schema §3)
            หน้านี้จึงแสดงนักเรียนทุกคนที่มีข้อมูล ไม่ใช่เฉพาะห้องของครูคนนี้
          </li>
          <li>• ยังไม่มีระบบเข้าสู่ระบบของครู (PRO-12) หน้านี้จึงปิดในโปรดักชัน</li>
          <li>
            • ทุกตัวเลขมาจาก snapshot ที่คำนวณไว้ตามนิยามการเติบโตของ PRO-3
            หน้าเว็ปไม่ได้คำนวณเองเลยสักตัว
          </li>
        </ul>
      </Card>
    </PageShell>
  );
}
