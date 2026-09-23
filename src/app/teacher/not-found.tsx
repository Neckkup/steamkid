import { ButtonLink, EmptyState, PageShell } from "@/components/ui";
import { env } from "@/lib/env";

/**
 * The 404 for teacher screens, because the app-wide one is written to a child.
 *
 * `src/app/not-found.tsx` says "หน้าที่**หนู**เปิดอาจย้ายที่ไปแล้ว ... กลับไป
 * เลือกบทเรียนกันต่อได้เลย" and offers "ดูบทเรียนทั้งหมด". That is right for a
 * ten-year-old and wrong for the adult it was reaching here: a teacher who
 * mistyped a verdict id was addressed as a child and then sent to the child's
 * lesson list, which is not where their work is (PRO-98 D3).
 *
 * This boundary covers the whole `/teacher` subtree, so it catches three
 * different callers: a malformed id (`isUuidV7` guard), an id that is well
 * formed but names no row (`notFound()` after the query), and the production
 * guard in `./guard.ts`.
 *
 * The production case is why the copy branches. On that tier
 * `assertTeacherSurfaceAllowed()` 404s *every* teacher route because there is
 * no teacher sign-in yet (PRO-12), so "go back to the review queue" would point
 * at a page that also does not exist there — and it would tell anyone probing
 * URLs that these screens exist at all. Production therefore gets the neutral
 * answer, which is also the honest one: on that tier this really is just a URL
 * the app does not serve.
 */
export default function TeacherNotFound() {
  if (env.APP_ENV === "production") {
    return (
      <PageShell>
        <EmptyState
          title="ไม่เจอหน้านี้"
          body="ลิงก์นี้อาจพิมพ์ผิด หรือเป็นหน้าที่ระบบนี้ไม่ได้เปิดให้ใช้"
          action={<ButtonLink href="/">กลับหน้าแรก</ButtonLink>}
        />
      </PageShell>
    );
  }

  return (
    <PageShell>
      <EmptyState
        title="ไม่เจอหน้านี้"
        body="ลิงก์อาจพิมพ์ผิดไปตัวหนึ่ง หรืองานชิ้นนี้ถูกลบไปแล้ว — ไม่ใช่ระบบล่ม ถ้าระบบมีปัญหาจริง หน้าอื่นจะเปิดไม่ได้ด้วย ลองเลือกจากรายการงานที่รอครูดูอีกครั้ง"
        action={<ButtonLink href="/teacher/review">กลับไปรายการงานที่รอครูดู</ButtonLink>}
      />
    </PageShell>
  );
}
