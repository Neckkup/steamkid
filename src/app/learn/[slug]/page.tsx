import { notFound, redirect } from "next/navigation";

import { getLessonBySlug } from "@/content";
import { ButtonLink, Card, PageShell } from "@/components/ui";
import { getConsentState } from "@/lib/learning/session";

import { LessonTracker } from "./lesson-tracker";

export const dynamic = "force-dynamic";

export default async function LessonPage({ params }: { params: Promise<{ slug: string }> }) {
  if ((await getConsentState()) === null) redirect("/consent");

  const { slug } = await params;
  const lesson = await getLessonBySlug(slug);
  if (!lesson) notFound();

  return (
    <PageShell>
      <LessonTracker lessonId={lesson.id} contentVersion={lesson.contentVersion} />

      <article>
        <header className="mb-6">
          <p className="text-base font-semibold text-brand-strong">
            บทที่ {lesson.orderIndex} · ประมาณ {lesson.estMinutes} นาที
          </p>
          <h1 className="mt-1 text-3xl font-bold leading-snug sm:text-4xl">{lesson.title}</h1>
          <p className="mt-2 text-lg text-muted">{lesson.summary}</p>
        </header>

        <div className="grid gap-6">
          {lesson.sections.map((section) => (
            <section key={section.id}>
              <h2 className="text-2xl font-bold leading-snug">{section.heading}</h2>
              {section.paragraphs.map((paragraph, index) => (
                <p key={index} className="mt-3 text-lg">
                  {paragraph}
                </p>
              ))}
              {section.note ? (
                <Card className="mt-4 border-brand bg-brand-soft">
                  <p className="font-semibold text-brand-strong">{section.note.label}</p>
                  <p className="mt-1">{section.note.text}</p>
                </Card>
              ) : null}
            </section>
          ))}
        </div>
      </article>

      {/* One next action, and it is the whole point of the page. */}
      <div className="mt-10 flex flex-col gap-3">
        <ButtonLink href={`/learn/${lesson.slug}/practice`}>ไปลองตอบคำถามกัน</ButtonLink>
        <ButtonLink href="/learn" tone="quiet">
          กลับไปหน้ารายการบทเรียน
        </ButtonLink>
      </div>
    </PageShell>
  );
}
