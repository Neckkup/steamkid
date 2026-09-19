import { ButtonLink, EmptyState, PageShell } from "@/components/ui";

/** A friendly 404. A child who mistypes a URL has not done anything wrong. */
export default function LessonNotFound() {
  return (
    <PageShell>
      <EmptyState
        title="ไม่เจอบทเรียนนี้"
        body="บทเรียนที่หนูเปิดอาจย้ายที่ไปแล้ว ลองเลือกจากรายการบทเรียนดูนะ"
        action={<ButtonLink href="/learn">ดูบทเรียนทั้งหมด</ButtonLink>}
      />
    </PageShell>
  );
}
