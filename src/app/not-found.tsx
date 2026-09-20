import { ButtonLink, EmptyState, PageShell } from "@/components/ui";

/**
 * The app-wide 404, for any URL no route matches.
 *
 * Without this file Next.js serves its own built-in page, which is English
 * ("404 — This page could not be found."), unstyled, and has no way back. On a
 * Thai app for ป.4–ป.6 that is not an acceptable last screen — PRO-47 found it
 * at the end of the main flow, and a missing route anywhere else would have
 * shown exactly the same thing.
 */
export default function NotFound() {
  return (
    <PageShell>
      <EmptyState
        title="ไม่เจอหน้านี้"
        body="หน้าที่หนูเปิดอาจย้ายที่ไปแล้ว หรือลิงก์พิมพ์ผิดไปนิดหนึ่ง ไม่เป็นไรเลย กลับไปเลือกบทเรียนกันต่อได้เลย"
        action={<ButtonLink href="/learn">ดูบทเรียนทั้งหมด</ButtonLink>}
      />
    </PageShell>
  );
}
