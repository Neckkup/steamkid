"use client";

import { Button, ErrorState, PageShell } from "@/components/ui";

/**
 * The teacher's error boundary. An adult can act on a retry too, and the
 * `error` object still stays off the screen — a database message could quote a
 * child's row.
 */
export default function TeacherError({ reset }: { error: Error; reset: () => void }) {
  return (
    <PageShell width="wide">
      <ErrorState
        title="ตอนนี้อ่านข้อมูลการเติบโตไม่ได้"
        body="ลองกดโหลดใหม่อีกครั้ง ถ้ายังไม่ได้ให้แจ้งทีมงานพร้อมเวลาที่เจอปัญหา"
        action={<Button onClick={reset}>ลองอีกครั้ง</Button>}
      />
    </PageShell>
  );
}
