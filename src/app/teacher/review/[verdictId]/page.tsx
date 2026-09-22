/**
 * One AI verdict, for the teacher who has to decide whether to stand behind it
 * — PRO-77, second screen.
 *
 * The page is laid out in the order a teacher actually reviews: what the child
 * wrote, then what the model said about each skill and what it quoted to back
 * that up, then the control to disagree. The AI's levels are never presented as
 * settled — every skill carries its own editor, because a teacher can agree
 * with one criterion and not the next, and a screen that only offered "accept
 * the whole thing" would collect corrections that say things no teacher meant.
 *
 * Three statuses, and only one of them has a score:
 *
 *   - `graded` — levels, a total, and text the child has already seen
 *   - `blocked_by_safety` — the model refused. **Not zero.** No criteria exist,
 *     so there is nothing to override and the page says so instead of drawing
 *     an empty rubric.
 *   - `unscorable` — the model read it and could not judge it. Also not zero.
 *
 * `criteria[].reason` is written for a teacher and stays on this page;
 * `feedbackToLearner` is the text written for the child and is shown quoted, so
 * a teacher can see what was said in their name.
 */

import Link from "next/link";
import { notFound } from "next/navigation";

import { DemoDataNotice, NoDataNotice } from "@/components/growth/notices";
import { SkillOverride } from "@/components/teacher/skill-override";
import { Card, PageHeading, PageShell, StatusPill } from "@/components/ui";
import { getItemById } from "@/content";
import { isDemoDatabase } from "@/lib/growth/runtime";
import { traceUrl } from "@/lib/observability/langfuse";
import {
  REASON_CODES,
  STATUS_COPY,
  UNSCORABLE_COPY,
  levelChoices,
  levelDescriptor,
  reasonCodeLabel,
  scoreText,
  skillLabel,
} from "@/lib/learning/review-present";
import { resolveReviewQueue } from "@/lib/learning/review-runtime";
import { resolveVerdictStore } from "@/lib/learning/verdict-runtime";
import type { EffectiveCriterion, TeacherOverride } from "@/lib/learning/verdict-store";

import { assertTeacherSurfaceAllowed } from "../../guard";

export const dynamic = "force-dynamic";

function thaiDateTime(iso: string): string {
  return new Date(iso).toLocaleString("th-TH", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function CriterionCard({
  verdictId,
  criterion,
  history,
}: {
  readonly verdictId: string;
  readonly criterion: EffectiveCriterion;
  readonly history: readonly TeacherOverride[];
}) {
  const descriptor = levelDescriptor(criterion.skillCode, criterion.level);
  const aiDescriptor = levelDescriptor(criterion.skillCode, criterion.aiLevel);

  return (
    <li>
      <Card tone={criterion.teacherCorrected ? "correct" : "plain"}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h3 className="text-xl font-bold">{skillLabel(criterion.skillCode)}</h3>
          <div className="flex flex-wrap gap-2">
            <StatusPill tone={criterion.teacherCorrected ? "correct" : "neutral"}>
              ระดับที่นับ {criterion.level}/3
            </StatusPill>
            {criterion.teacherCorrected ? (
              <StatusPill tone="waiting">AI เคยให้ {criterion.aiLevel}/3</StatusPill>
            ) : null}
          </div>
        </div>
        <p className="mt-1 text-base text-muted">
          น้ำหนักของข้อนี้ {Math.round(criterion.weight * 100)}%
          {criterion.teacherCorrected ? " · ระดับนี้ครูเป็นคนให้" : " · ระดับนี้ AI เป็นคนให้"}
        </p>

        {descriptor ? (
          <p className="mt-3 rounded-2xl bg-brand-soft px-4 py-3 text-base">
            <span className="font-semibold">ระดับ {criterion.level} คือ:</span> {descriptor}
          </p>
        ) : (
          <p className="mt-3 text-base text-notyet">
            เกณฑ์ของทักษะ {criterion.skillCode} ไม่อยู่ใน rubric ฉบับที่หน้าเว็บนี้ถืออยู่
            จึงแสดงคำบรรยายระดับให้ไม่ได้
          </p>
        )}

        {criterion.teacherCorrected && aiDescriptor ? (
          <p className="mt-2 text-base text-muted">
            <span className="font-semibold">ตอนแรก AI ให้ระดับ {criterion.aiLevel}:</span>{" "}
            {aiDescriptor}
          </p>
        ) : null}

        <div className="mt-4">
          <h4 className="text-base font-bold">เหตุผลของ AI (เขียนถึงครู ไม่ได้ส่งให้เด็กอ่าน)</h4>
          <p className="mt-1 text-base">{criterion.reason}</p>
        </div>

        {criterion.evidence ? (
          <figure className="mt-4">
            <figcaption className="text-base font-bold">ข้อความที่ AI ยกมาเป็นหลักฐาน</figcaption>
            <blockquote className="mt-1 border-l-4 border-brand pl-4 text-base italic">
              “{criterion.evidence}”
            </blockquote>
          </figure>
        ) : (
          <p className="mt-4 text-base text-muted">AI ไม่ได้ยกข้อความไหนมาเป็นหลักฐานสำหรับข้อนี้</p>
        )}

        <SkillOverride
          verdictId={verdictId}
          skillCode={criterion.skillCode}
          skillName={skillLabel(criterion.skillCode)}
          currentLevel={criterion.level}
          aiLevel={criterion.aiLevel}
          choices={levelChoices(criterion.skillCode)}
          reasonCodes={REASON_CODES}
        />

        {history.length > 0 ? (
          <details className="mt-4">
            <summary className="tap cursor-pointer text-base font-semibold">
              ประวัติการแก้ของทักษะนี้ ({history.length} ครั้ง)
            </summary>
            <ol className="mt-2 grid gap-2">
              {history.map((entry) => (
                <li key={entry.id} className="text-base text-muted">
                  {thaiDateTime(entry.createdAt)} · {entry.originalLevel} →{" "}
                  {entry.correctedLevel} · {reasonCodeLabel(entry.reasonCode)}
                  {entry.note ? <span className="block">“{entry.note}”</span> : null}
                </li>
              ))}
            </ol>
          </details>
        ) : null}
      </Card>
    </li>
  );
}

export default async function TeacherVerdictReviewPage({
  params,
}: {
  readonly params: Promise<{ verdictId: string }>;
}) {
  assertTeacherSurfaceAllowed();

  const { verdictId } = await params;
  const queue = await resolveReviewQueue();
  const demo = isDemoDatabase();

  if (!queue) {
    return (
      <PageShell width="wide">
        <PageHeading title="ผลตรวจของ AI" />
        <NoDataNotice audience="teacher" />
      </PageShell>
    );
  }

  const subject = await queue.subject(verdictId);
  // `resolveReviewQueue()` has already installed the store for the demo
  // database, so this is non-null wherever `subject` was.
  const store = resolveVerdictStore();
  const verdict = store ? await store.getEffective(verdictId) : null;
  if (!subject || !verdict) notFound();

  const overrides = store ? await store.listOverrides(verdictId) : [];
  const copy = STATUS_COPY[verdict.status];
  const item = await getItemById(subject.itemId);
  const trace = traceUrl(subject.correlationId);
  const learnerName = subject.learnerName ?? `นักเรียน ${subject.learnerRef.slice(0, 8)}`;

  return (
    <PageShell width="wide">
      {/* `inline-flex`, because `.tap`'s min-height does nothing to an inline
          element and this link measured 27px on a phone. */}
      <Link
        href="/teacher/review"
        className="tap mb-2 inline-flex items-center text-brand-strong underline underline-offset-4"
      >
        ← กลับไปรายการงานที่รอครูดู
      </Link>

      <PageHeading
        title={`งานของ ${learnerName}`}
        lead={`${item ? item.lesson.title : "บทเรียน"} · ครั้งที่ ${subject.attemptNumber} · ส่งเมื่อ ${thaiDateTime(subject.createdAt)}`}
      />
      {demo ? <DemoDataNotice /> : null}

      <Card tone={copy.cardTone}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h2 className="text-2xl font-bold">{copy.title}</h2>
          <StatusPill tone={copy.tone}>{copy.pill}</StatusPill>
        </div>
        <p className="mt-2 text-lg">{copy.body}</p>

        {verdict.status === "graded" ? (
          <dl className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl bg-surface px-4 py-3">
              <dt className="text-base text-muted">คะแนนที่ใช้จริงตอนนี้</dt>
              <dd className="text-2xl font-bold">{scoreText(verdict.normalizedScore)}</dd>
            </div>
            <div className="rounded-2xl bg-surface px-4 py-3">
              <dt className="text-base text-muted">คะแนนที่ AI ให้ไว้ตอนแรก</dt>
              <dd className="text-2xl font-bold">{scoreText(verdict.aiNormalizedScore)}</dd>
            </div>
          </dl>
        ) : (
          <p className="mt-4 rounded-2xl bg-surface px-4 py-3 text-lg font-bold">
            ยังไม่มีคะแนนสำหรับงานชิ้นนี้ — ไม่ใช่ 0 คะแนน
          </p>
        )}

        {verdict.status === "unscorable" && verdict.unscorableReason ? (
          <p className="mt-3 text-lg">
            <span className="font-semibold">เหตุผล:</span>{" "}
            {UNSCORABLE_COPY[verdict.unscorableReason]}
          </p>
        ) : null}

        {verdict.statusDetail ? (
          <p className="mt-3 text-base">
            <span className="font-semibold">รายละเอียดจากโมเดล (สำหรับครู):</span>{" "}
            {verdict.statusDetail}
          </p>
        ) : null}

        <p className="mt-3 text-base text-muted">{copy.learnerSees}</p>
      </Card>

      {item ? (
        <Card className="mt-6">
          <h2 className="text-xl font-bold">โจทย์</h2>
          <p className="mt-2 text-lg">{item.item.prompt}</p>
        </Card>
      ) : null}

      <Card className="mt-6">
        <h2 className="text-xl font-bold">คำตอบของเด็ก</h2>
        <p className="mt-1 text-base text-muted">
          ข้อความเดียวกับที่ส่งให้ AI อ่าน (ผ่านการลบข้อมูลส่วนตัวแล้ว — {subject.redactionVersion})
        </p>
        {subject.answer ? (
          <blockquote className="mt-3 whitespace-pre-wrap rounded-2xl bg-brand-soft px-4 py-3 text-lg">
            {subject.answer}
          </blockquote>
        ) : (
          <p className="mt-3 text-base text-notyet">
            ไม่พบข้อความคำตอบใน input_snapshot ของ verdict นี้
          </p>
        )}
      </Card>

      {verdict.status === "graded" && verdict.feedbackToLearner ? (
        <Card className="mt-6">
          <h2 className="text-xl font-bold">ข้อความที่เด็กได้อ่าน</h2>
          <p className="mt-1 text-base text-muted">
            เขียนถึงเด็ก ไม่ใช่เหตุผลการให้คะแนน — เหตุผลอยู่ในแต่ละทักษะข้างล่าง
          </p>
          <blockquote className="mt-3 rounded-2xl bg-correct-soft px-4 py-3 text-lg">
            {verdict.feedbackToLearner}
          </blockquote>
          {verdict.nextStep ? (
            <p className="mt-3 text-lg">
              <span className="font-semibold">สิ่งที่ชวนให้ทำต่อ:</span> {verdict.nextStep}
            </p>
          ) : null}
        </Card>
      ) : null}

      <section className="mt-8">
        <h2 className="text-2xl font-bold">ระดับรายทักษะ</h2>
        <p className="mt-1 text-base text-muted">
          แก้ได้ทีละทักษะ ทักษะที่ครูไม่ได้แตะจะไม่ถูกนับว่าครูยืนยันค่าเดิม
        </p>

        {verdict.criteria.length === 0 ? (
          <Card tone="waiting" className="mt-4">
            <h3 className="text-xl font-bold">ยังไม่มีระดับให้แก้</h3>
            <p className="mt-2 text-lg">
              AI ไม่ได้ให้ระดับสักทักษะสำหรับงานชิ้นนี้ จึงยังไม่มีค่าเดิมให้ครูแก้
              ตอนนี้ทำได้สองทาง: อ่านคำตอบข้างบนแล้วให้เด็กแก้แล้วส่งใหม่
              หรือรอช่องทางให้ครูให้ระดับเองตั้งแต่ต้น ซึ่งยังไม่มีในรุ่นนี้
            </p>
          </Card>
        ) : (
          <ul className="mt-4 grid gap-4">
            {verdict.criteria.map((criterion) => (
              <CriterionCard
                key={criterion.skillCode}
                verdictId={verdictId}
                criterion={criterion}
                history={overrides.filter((entry) => entry.skillCode === criterion.skillCode)}
              />
            ))}
          </ul>
        )}
      </section>

      <Card className="mt-8">
        <h2 className="text-xl font-bold">ที่มาของผลตรวจนี้</h2>
        <dl className="mt-2 grid gap-2 text-base sm:grid-cols-2">
          <div>
            <dt className="text-muted">โมเดล</dt>
            <dd className="font-semibold">{subject.model}</dd>
          </div>
          <div>
            <dt className="text-muted">prompt</dt>
            <dd className="font-semibold">
              {subject.promptName}@{subject.promptVersion}
            </dd>
          </div>
          <div>
            <dt className="text-muted">rubric</dt>
            <dd className="font-semibold">{subject.rubricVersion}</dd>
          </div>
          <div>
            <dt className="text-muted">correlation id</dt>
            <dd className="font-mono text-sm break-all">{subject.correlationId}</dd>
          </div>
        </dl>
        {trace ? (
          <p className="mt-4">
            <a
              href={trace}
              target="_blank"
              rel="noreferrer"
              className="tap text-brand-strong underline underline-offset-4"
            >
              เปิด trace ตัวจริงใน Langfuse ↗
            </a>
          </p>
        ) : (
          <p className="mt-4 text-base text-muted">
            สภาพแวดล้อมนี้ยังไม่ได้ตั้งค่า Langfuse จึงยังลิงก์ไป trace ไม่ได้
          </p>
        )}
      </Card>
    </PageShell>
  );
}
