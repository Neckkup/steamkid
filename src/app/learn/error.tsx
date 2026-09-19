"use client";

import { Button, ErrorState, PageShell } from "@/components/ui";

/**
 * The error boundary for everything under `/learn`.
 *
 * It shows a child one sentence and one button. The `error` object is not
 * rendered: a child cannot act on a stack trace, and a message from the server
 * could quote something that should not be on screen.
 */
export default function LearnError({ reset }: { error: Error; reset: () => void }) {
  return (
    <PageShell>
      <ErrorState
        title="ตอนนี้เปิดบทเรียนไม่ได้"
        body="ไม่ใช่ความผิดของหนูเลย ลองกดปุ่มข้างล่างดูอีกครั้งนะ"
        action={<Button onClick={reset}>ลองอีกครั้ง</Button>}
      />
    </PageShell>
  );
}
