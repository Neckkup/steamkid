import { ButtonLink, EmptyState, PageShell } from "@/components/ui";

/**
 * An id that belongs to nobody, or to another child. Both look the same from
 * here on purpose — the screen never hints that the work exists but is someone
 * else's — and neither is the child's fault, so the copy does not scold.
 */
export default function ResultNotFound() {
  return (
    <PageShell>
      <EmptyState
        title="ไม่เจองานชิ้นนี้"
        body="ลิงก์นี้อาจพิมพ์ผิดไปนิดเดียว หรือเป็นงานของเพื่อนคนอื่น ลองกลับไปเลือกบทเรียนแล้วเปิดงานของหนูใหม่นะ"
        action={<ButtonLink href="/learn">ดูบทเรียนทั้งหมด</ButtonLink>}
      />
    </PageShell>
  );
}
