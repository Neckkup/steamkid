import { notFound, redirect } from "next/navigation";

import { getLessonBySlug } from "@/content";
import { practiceItems, projectItem } from "@/content/public";
import { ButtonLink, EmptyState, PageShell } from "@/components/ui";
import { getConsentState } from "@/lib/learning/session";

import { PracticeRunner } from "./practice-runner";

export const dynamic = "force-dynamic";

export default async function PracticePage({ params }: { params: Promise<{ slug: string }> }) {
  if ((await getConsentState()) === null) redirect("/consent");

  const { slug } = await params;
  const lesson = await getLessonBySlug(slug);
  if (!lesson) notFound();

  const items = practiceItems(lesson);
  if (items.length === 0) {
    return (
      <PageShell>
        <EmptyState
          title="บทนี้ยังไม่มีคำถาม"
          body="เรากำลังเขียนคำถามของบทนี้อยู่ ระหว่างนี้ลองเลือกบทอื่นดูได้นะ"
          action={<ButtonLink href="/learn">ดูบทเรียนทั้งหมด</ButtonLink>}
        />
      </PageShell>
    );
  }

  return (
    <PracticeRunner
      lessonId={lesson.id}
      lessonSlug={lesson.slug}
      lessonTitle={lesson.title}
      exerciseSetId={lesson.exerciseSetId}
      items={items}
      hasProject={projectItem(lesson) !== undefined}
    />
  );
}
