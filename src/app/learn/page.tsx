import Link from "next/link";
import { redirect } from "next/navigation";

import { getCourse, listLessons } from "@/content";
import { ButtonLink, Card, EmptyState, PageHeading, PageShell } from "@/components/ui";
import { getConsentState } from "@/lib/learning/session";

export const dynamic = "force-dynamic";

/** The lesson list. Cards big enough to tap with a thumb, one line of why. */
export default async function LearnPage() {
  if ((await getConsentState()) === null) redirect("/consent");

  const [course, lessons] = await Promise.all([getCourse(), listLessons()]);

  if (lessons.length === 0) {
    return (
      <PageShell>
        <PageHeading title="บทเรียนของหนู" />
        <EmptyState
          title="ยังไม่มีบทเรียนให้เรียนตอนนี้"
          body="เรากำลังเขียนบทเรียนใหม่อยู่ กลับมาดูใหม่เร็ว ๆ นี้นะ"
          action={<ButtonLink href="/">กลับหน้าแรก</ButtonLink>}
        />
      </PageShell>
    );
  }

  return (
    <PageShell>
      <PageHeading title="บทเรียนของหนู" lead={`หน่วย: ${course.title}`} />

      <ol className="grid gap-4">
        {lessons.map((lesson, index) => (
          <li key={lesson.id}>
            <Link
              href={`/learn/${lesson.slug}`}
              className="block rounded-3xl border border-line bg-surface p-5 transition-colors hover:border-brand hover:bg-brand-soft sm:p-6"
            >
              <span className="text-base font-semibold text-brand-strong">
                บทที่ {index + 1}
              </span>
              <h2 className="mt-1 text-2xl font-bold leading-snug">{lesson.title}</h2>
              <p className="mt-2 text-muted">{lesson.summary}</p>
              <p className="mt-3 text-base text-muted">
                ใช้เวลาประมาณ {lesson.estMinutes} นาที · มีคำถาม {lesson.items.length} ข้อ
              </p>
            </Link>
          </li>
        ))}
      </ol>

      <Card className="mt-6 border-waiting bg-waiting-soft">
        <p>
          หน่วยนี้วางแผนไว้ 6 บท ตอนนี้เขียนเสร็จแล้ว {lessons.length} บท
          ที่เหลือกำลังเขียนอยู่ เราจะไม่แสดงบทที่ยังไม่มีเนื้อหาให้กดเข้าไปเจอหน้าเปล่า
        </p>
      </Card>
    </PageShell>
  );
}
