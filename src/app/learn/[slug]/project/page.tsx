import { notFound, redirect } from "next/navigation";

import { getLessonBySlug } from "@/content";
import { projectItem } from "@/content/public";
import { ButtonLink, EmptyState, PageShell } from "@/components/ui";
import { getConsentState } from "@/lib/learning/session";

import { ProjectEditor } from "./project-editor";

export const dynamic = "force-dynamic";

export default async function ProjectPage({ params }: { params: Promise<{ slug: string }> }) {
  if ((await getConsentState()) === null) redirect("/consent");

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

  return (
    <ProjectEditor
      lessonId={lesson.id}
      lessonSlug={lesson.slug}
      lessonTitle={lesson.title}
      item={item}
    />
  );
}
