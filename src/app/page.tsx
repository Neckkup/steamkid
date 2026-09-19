import { getCourse } from "@/content";
import { ButtonLink, Card, PageShell } from "@/components/ui";
import { getConsentState } from "@/lib/learning/session";

/**
 * The front door.
 *
 * It has exactly one primary action, and which one depends on whether a
 * guardian has been through the consent screen yet — a child who lands here
 * with consent already recorded should not be asked to read an adult's page
 * again before they can learn anything.
 */
export default async function HomePage() {
  const [course, consent] = await Promise.all([getCourse(), getConsentState()]);
  const ready = consent !== null;

  return (
    <PageShell>
      <section className="text-center">
        <p className="text-6xl" aria-hidden="true">
          🚀
        </p>
        <h1 className="mt-4 text-3xl font-bold leading-snug sm:text-4xl">
          มาลองคิดแบบนักวิทยาศาสตร์กัน
        </h1>
        <p className="mt-3 text-lg text-muted">
          อ่านบทเรียนสั้น ๆ ลองตอบคำถาม แล้วเขียนความคิดของหนูออกมา
        </p>

        <div className="mt-8 flex justify-center">
          {ready ? (
            <ButtonLink href="/learn">เริ่มเรียนเลย</ButtonLink>
          ) : (
            <ButtonLink href="/consent">เริ่มต้นใช้งาน</ButtonLink>
          )}
        </div>
        {ready ? null : (
          <p className="mt-3 text-base text-muted">
            ขั้นแรกให้ผู้ปกครองอ่านและยินยอมก่อนนะ ใช้เวลาไม่ถึงหนึ่งนาที
          </p>
        )}
      </section>

      <Card className="mt-10">
        <h2 className="text-2xl font-bold">หน่วยแรกของหนู</h2>
        <p className="mt-1 text-xl font-semibold text-brand-strong">{course.title}</p>
        <p className="mt-2 text-muted">
          {course.subject} · สำหรับ {course.gradeBand} · มี {course.lessons.length} บทเรียน
        </p>
        <ul className="mt-4 grid gap-2">
          {course.lessons.map((lesson) => (
            <li key={lesson.id} className="flex gap-2">
              <span aria-hidden="true">•</span>
              <span>{lesson.title}</span>
            </li>
          ))}
        </ul>
      </Card>

      <Card className="mt-6 border-waiting bg-waiting-soft">
        <h2 className="text-xl font-bold">สำหรับผู้ปกครองและคุณครู</h2>
        <p className="mt-2">
          steamkid กำลังอยู่ระหว่างพัฒนา ตอนนี้ยังไม่มีการตรวจงานเขียนด้วย AI
          และยังไม่มีแดชบอร์ดการเติบโต เราจะไม่แสดงคะแนนที่ยังไม่ได้ตรวจจริง
        </p>
        <p className="mt-2">
          หน้าจัดการความยินยอมอยู่ที่{" "}
          <a className="font-semibold underline underline-offset-4" href="/consent">
            หน้าความยินยอม
          </a>
        </p>
      </Card>
    </PageShell>
  );
}
