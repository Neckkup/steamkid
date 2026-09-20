/**
 * Where a child lands the moment they press "ส่งงานของหนู".
 *
 * `project-editor.tsx` has always pushed here; the route simply did not exist,
 * so the last step of the main flow was a bare English 404 (PRO-47). What the
 * screen owes a child, in order:
 *
 *   1. **Say the work arrived.** A child who just spent twenty minutes writing
 *      needs to see their own words back, not a spinner and not a score.
 *   2. **Tell the truth about grading.** There is no grader yet (PRO-8), so the
 *      API answers `awaiting_grading` and this page says exactly that in a way
 *      a ten-year-old reads as "fine" rather than "broken". No number is shown
 *      because nobody calculated one.
 *   3. **Give one obvious way onward.** The 404 had no way back at all.
 *
 * Server component: the submission is read with the learner's own pseudonymous
 * ref, so one child can never open another child's work by pasting an id.
 */

import { notFound, redirect } from "next/navigation";

import { ButtonLink, Card, PageShell, StatusPill } from "@/components/ui";
import { getLessonById, getNextLesson } from "@/content";
import { getConsentState, getLearnerRef } from "@/lib/learning/session";
import { getLearningStore } from "@/lib/learning/store";

export const dynamic = "force-dynamic";

/** "ส่งเมื่อ 20 ก.ย. 2569 เวลา 14:32 น." — the child's own clock, not UTC. */
const SUBMITTED_AT = new Intl.DateTimeFormat("th-TH", {
  dateStyle: "long",
  timeStyle: "short",
  timeZone: "Asia/Bangkok",
});

export default async function ResultPage({
  params,
}: {
  readonly params: Promise<{ submissionId: string }>;
}) {
  const learnerRef = await getLearnerRef();
  if (!learnerRef || (await getConsentState()) === null) redirect("/consent");

  const { submissionId } = await params;
  const submission = await getLearningStore().getSubmission(learnerRef, submissionId);
  if (!submission) notFound();

  const lesson = await getLessonById(submission.lessonId);
  const nextLesson = lesson ? await getNextLesson(lesson.slug) : undefined;
  const latest = submission.drafts[submission.drafts.length - 1];

  // Reached by URL rather than by submitting: the work is saved but the child
  // never pressed send. Saying "ส่งเรียบร้อย" here would be a lie.
  if (!submission.submittedAt) {
    return (
      <PageShell>
        <Card className="border-line text-center">
          <p className="text-5xl" aria-hidden="true">
            📝
          </p>
          <h1 className="mt-3 text-2xl font-bold leading-snug">งานชิ้นนี้ยังเป็นร่างอยู่</h1>
          <p className="mt-2 text-lg">
            เราเก็บสิ่งที่หนูเขียนไว้ให้แล้ว แต่ยังไม่ได้ส่ง กลับไปเขียนต่อแล้วกดส่งได้เลยนะ
          </p>
        </Card>

        <div className="mt-8 flex flex-col gap-3">
          {lesson ? (
            <ButtonLink href={`/learn/${lesson.slug}/project`}>กลับไปเขียนงานต่อ</ButtonLink>
          ) : (
            <ButtonLink href="/learn">ดูบทเรียนทั้งหมด</ButtonLink>
          )}
          <ButtonLink href="/learn" tone="quiet">
            กลับไปหน้ารายการบทเรียน
          </ButtonLink>
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <Card className="border-correct bg-correct-soft text-center">
        <p className="text-5xl" aria-hidden="true">
          🎉
        </p>
        <StatusPill tone="correct">ส่งงานเรียบร้อย</StatusPill>
        {/* 2xl on a phone so the sentence stays on one line; "แล้ว" alone on a
            second line is the kind of break a child reads twice. */}
        <h1 className="mt-3 text-2xl font-bold leading-snug sm:text-3xl">งานของหนูถึงมือเราแล้ว</h1>
        <p className="mt-2 text-lg">
          เก็บไว้เรียบร้อยแล้ว ไม่หายไปไหนแน่นอน เก่งมากที่เขียนจนจบนะ
        </p>
      </Card>

      {/*
        The honest part. The child is told there is no feedback today, why, and
        that nothing about that is their fault — not left to wonder why the page
        has no score on it.
      */}
      <Card className="mt-6 border-waiting bg-waiting-soft">
        <StatusPill tone="waiting">รอครู AI อ่าน</StatusPill>
        <h2 className="mt-3 text-2xl font-bold leading-snug">แล้วจะรู้ผลตอนไหน?</h2>
        <p className="mt-2 text-lg">
          งานเขียนแบบนี้ต้องให้ครู AI อ่านแล้วเขียนคำแนะนำกลับมา ตอนนี้ระบบตรวจยังทำไม่เสร็จ
          หนูจึงยังไม่ได้คำแนะนำในวันนี้ ไม่ใช่เพราะงานของหนูนะ
        </p>
        <p className="mt-2 text-lg">พอครู AI อ่านงานได้เมื่อไหร่ คำแนะนำจะมาอยู่ที่หน้านี้</p>
      </Card>

      <Card className="mt-6">
        <h2 className="text-2xl font-bold leading-snug">งานที่หนูส่ง</h2>
        <p className="mt-1 text-base text-muted">
          {lesson ? `บท “${lesson.title}” · ` : null}
          ส่งเมื่อ {SUBMITTED_AT.format(new Date(submission.submittedAt))} น.
          {latest ? ` · ยาว ${latest.charCount} ตัวอักษร` : null}
        </p>
        {latest ? (
          <p className="mt-3 whitespace-pre-wrap rounded-2xl bg-brand-soft p-4 text-lg">
            {latest.content}
          </p>
        ) : null}
      </Card>

      {/* One obvious next action, and a way back to the lesson either way. */}
      <div className="mt-8 flex flex-col gap-3">
        {nextLesson ? (
          <ButtonLink href={`/learn/${nextLesson.slug}`}>ไปเรียนบทต่อไป</ButtonLink>
        ) : (
          <ButtonLink href="/learn">เลือกบทเรียนต่อไป</ButtonLink>
        )}
        {lesson ? (
          <ButtonLink href={`/learn/${lesson.slug}`} tone="secondary">
            กลับไปอ่านบทนี้อีกครั้ง
          </ButtonLink>
        ) : null}
        <ButtonLink href="/learn" tone="quiet">
          กลับไปหน้ารายการบทเรียน
        </ButtonLink>
      </div>
    </PageShell>
  );
}
