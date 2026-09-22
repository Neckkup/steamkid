import { notFound, redirect } from "next/navigation";

import { getLessonBySlug } from "@/content";
import { projectItem } from "@/content/public";
import { ButtonLink, EmptyState, PageShell } from "@/components/ui";
import { getConsentState, getLearnerRef } from "@/lib/learning/session";
import { getLearningStore, latestSubmissionFor } from "@/lib/learning/store";

import { ProjectEditor } from "./project-editor";

export const dynamic = "force-dynamic";

/** "20 ก.ย. 2569 เวลา 14:32 น." — the child's own clock, as on the result page. */
const SUBMITTED_AT = new Intl.DateTimeFormat("th-TH", {
  dateStyle: "long",
  timeStyle: "short",
  timeZone: "Asia/Bangkok",
});

export default async function ProjectPage({ params }: { params: Promise<{ slug: string }> }) {
  const learnerRef = await getLearnerRef();
  if (!learnerRef || (await getConsentState()) === null) redirect("/consent");

  const { slug } = await params;
  const lesson = await getLessonBySlug(slug);
  if (!lesson) notFound();

  const item = projectItem(lesson);
  if (!item) {
    return (
      <PageShell>
        <EmptyState
          title="บทนี้ยังไม่มีชิ้นงาน"
          body="บทนี้มีแต่คำถามสั้น ๆ ลองเลือกบทอื่นที่มีชิ้นงานให้เขียนดูนะ"
          action={<ButtonLink href="/learn">ดูบทเรียนทั้งหมด</ButtonLink>}
        />
      </PageShell>
    );
  }

  // What this child already wrote for this project, if anything. Read on the
  // server with their own ref, so the editor never asks the browser for work
  // the browser could name a different child's id for (PRO-42).
  const previous = latestSubmissionFor(
    await getLearningStore().listSubmissions(learnerRef, lesson.id),
    item.id,
  );

  // Formatted here rather than in the client component: a date rendered from
  // the browser's locale would not match the server's first paint.
  const resumed = previous
    ? {
        submissionId: previous.id,
        text: previous.drafts[previous.drafts.length - 1]!.content,
        draftCount: previous.drafts.length,
        submittedAtLabel: previous.submittedAt
          ? SUBMITTED_AT.format(new Date(previous.submittedAt))
          : null,
      }
    : undefined;

  return (
    <ProjectEditor
      lessonId={lesson.id}
      lessonSlug={lesson.slug}
      lessonTitle={lesson.title}
      item={item}
      resumed={resumed}
    />
  );
}
