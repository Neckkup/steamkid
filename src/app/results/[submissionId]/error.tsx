"use client";

import { Button, ButtonLink, ErrorState, PageShell } from "@/components/ui";

/**
 * If this screen fails, the child's work is still saved — the POST that
 * brought them here already returned. Saying so is the whole job of this copy;
 * a child who thinks their writing is gone does not write the next one.
 */
export default function ResultError({ reset }: { error: Error; reset: () => void }) {
  return (
    <PageShell>
      <ErrorState
        title="ตอนนี้ยังเปิดหน้านี้ไม่ได้"
        body="งานของหนูส่งถึงเราแล้วและเก็บไว้เรียบร้อย ไม่หายไปไหนนะ ลองกดเปิดอีกครั้งได้เลย"
        action={<Button onClick={reset}>ลองอีกครั้ง</Button>}
      />
      <div className="mt-8 flex justify-center">
        <ButtonLink href="/learn" tone="quiet">
          กลับไปหน้ารายการบทเรียน
        </ButtonLink>
      </div>
    </PageShell>
  );
}
