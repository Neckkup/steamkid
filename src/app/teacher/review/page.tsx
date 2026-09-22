/**
 * The teacher's review queue — PRO-77, first screen.
 *
 * Sorted so the top row is the child nothing has been returned to. A verdict
 * whose status is not `graded` produced no score at all, so that child has been
 * looking at "ส่งให้ครูดูแล้ว" ever since they pressed submit; a graded verdict
 * has already reached them and can wait. Inside the waiting group the oldest is
 * first, because the longest wait is the one that has gone wrong.
 *
 * The same two limits as the rest of `/teacher` apply: there is no classroom in
 * the schema yet, so this is every learner rather than one teacher's class, and
 * there is no teacher sign-in (PRO-12), so the route 404s in production.
 */

import Link from "next/link";

import { DemoDataNotice, NoDataNotice } from "@/components/growth/notices";
import { Card, EmptyState, PageHeading, PageShell, StatusPill } from "@/components/ui";
import { getItemById } from "@/content";
import { isDemoDatabase } from "@/lib/growth/runtime";
import { STATUS_COPY, waitedFor } from "@/lib/learning/review-present";
import type { ReviewQueueEntry } from "@/lib/learning/review-queue";
import { resolveReviewQueue } from "@/lib/learning/review-runtime";

import { assertTeacherSurfaceAllowed } from "../guard";
import { DemoTeacherSignIn } from "./demo-sign-in";

export const dynamic = "force-dynamic";

async function itemTitle(itemId: string): Promise<string> {
  const found = await getItemById(itemId);
  if (!found) return "งานเขียน";
  return `${found.lesson.title} · ${found.item.prompt.slice(0, 60)}${
    found.item.prompt.length > 60 ? "…" : ""
  }`;
}

async function QueueRow({ entry }: { readonly entry: ReviewQueueEntry }) {
  const copy = STATUS_COPY[entry.status];
  const name = entry.learnerName ?? `นักเรียน ${entry.learnerRef.slice(0, 8)}`;

  return (
    <li>
      <Link
        href={`/teacher/review/${entry.verdictId}`}
        className="block rounded-3xl border border-line bg-surface p-5 transition-colors hover:border-brand hover:bg-brand-soft"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-xl font-bold">{name}</h2>
            <p className="mt-1 text-base text-muted">{await itemTitle(entry.itemId)}</p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <StatusPill tone={copy.tone}>{copy.pill}</StatusPill>
            {entry.teacherCorrected ? (
              <StatusPill tone="correct">ครูแก้แล้ว {entry.correctedSkillCount} ทักษะ</StatusPill>
            ) : null}
          </div>
        </div>

        <p className="mt-3 text-base text-muted">
          {entry.awaitingTeacher ? "รอครูตั้งแต่" : "ส่งเมื่อ"} {waitedFor(entry.createdAt)}
          {" · "}
          ครั้งที่ {entry.attemptNumber}
        </p>
      </Link>
    </li>
  );
}

export default async function TeacherReviewQueuePage() {
  assertTeacherSurfaceAllowed();

  const queue = await resolveReviewQueue();
  const demo = isDemoDatabase();

  if (!queue) {
    return (
      <PageShell width="wide">
        <PageHeading title="งานที่รอครูดู" />
        <NoDataNotice audience="teacher" />
      </PageShell>
    );
  }

  const entries = await queue.list();
  const waiting = entries.filter((entry) => entry.awaitingTeacher);
  const graded = entries.filter((entry) => !entry.awaitingTeacher);

  return (
    <PageShell width="wide">
      <PageHeading
        title="งานที่รอครูดู"
        lead="ชิ้นที่ AI ไม่ได้ให้คะแนนขึ้นก่อน เพราะเด็กยังไม่ได้ผลกลับไปเลย"
      />
      {demo ? <DemoDataNotice /> : null}
      {demo ? <DemoTeacherSignIn /> : null}

      {entries.length === 0 ? (
        <EmptyState
          title="ยังไม่มีงานที่ AI ตรวจไว้"
          body="เมื่อมีเด็กส่งงานเขียนและระบบตรวจเสร็จ รายการจะขึ้นที่นี่ ชิ้นที่ AI ตรวจไม่ได้จะอยู่บนสุดเสมอ"
        />
      ) : (
        <div className="grid gap-8">
          <section>
            <h2 className="mb-3 text-xl font-bold">
              รอครูอยู่จริง ๆ ({waiting.length})
            </h2>
            {waiting.length === 0 ? (
              <Card tone="correct">
                <p className="text-lg">
                  ไม่มีชิ้นที่ค้างอยู่ — ทุกชิ้นที่ส่งมา AI ตรวจผ่านหมดแล้ว
                </p>
              </Card>
            ) : (
              <ul className="grid gap-4">
                {waiting.map((entry) => (
                  <QueueRow key={entry.verdictId} entry={entry} />
                ))}
              </ul>
            )}
          </section>

          {graded.length > 0 ? (
            <section>
              <h2 className="mb-3 text-xl font-bold">AI ตรวจแล้ว ({graded.length})</h2>
              <p className="mb-3 text-base text-muted">
                เด็กได้ผลกลับไปแล้ว แต่ครูยังเข้าไปแก้ระดับรายทักษะได้ตลอด
              </p>
              <ul className="grid gap-4">
                {graded.map((entry) => (
                  <QueueRow key={entry.verdictId} entry={entry} />
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      )}

      <Card tone="waiting" className="mt-8">
        <h2 className="text-xl font-bold">ข้อจำกัดของหน้านี้ตอนนี้</h2>
        <ul className="mt-2 grid gap-2">
          <li>• ยังไม่มีตาราง “ห้องเรียน” ใน schema หน้านี้จึงแสดงงานของนักเรียนทุกคน</li>
          <li>• ยังไม่มีระบบเข้าสู่ระบบของครู (PRO-12) หน้านี้จึงปิดในโปรดักชัน</li>
        </ul>
      </Card>
    </PageShell>
  );
}
