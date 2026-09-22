"use client";

import { Button, ErrorState, PageShell } from "@/components/ui";

/**
 * The error boundary for the child's growth screen.
 *
 * Same rule as `/learn`: one sentence, one button, and nothing from the `error`
 * object on screen. A failure to read a snapshot must not read to a child as a
 * failure of theirs, so the copy says so explicitly.
 */
export default function MyGrowthError({ reset }: { error: Error; reset: () => void }) {
  return (
    <PageShell>
      <ErrorState
        title="ตอนนี้ยังเปิดหน้านี้ไม่ได้"
        body="ไม่เกี่ยวกับงานของหนูเลยนะ ลองกดปุ่มข้างล่างอีกครั้ง"
        action={<Button onClick={reset}>ลองอีกครั้ง</Button>}
      />
    </PageShell>
  );
}
