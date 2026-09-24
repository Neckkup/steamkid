"use client";

import { Button, ButtonLink, ErrorState, PageShell } from "@/components/ui";

/** Error boundary for the consent page. */
export default function ConsentError({ reset }: { error: Error; reset: () => void }) {
  return (
    <PageShell>
      <ErrorState
        title="ตอนนี้เปิดหน้านี้ไม่ได้"
        body="ลองกดปุ่มข้างล่างอีกครั้งได้เลย"
        action={<Button onClick={reset}>ลองอีกครั้ง</Button>}
      />
      <div className="mt-6 flex justify-center">
        <ButtonLink href="/" tone="quiet">
          กลับหน้าแรก
        </ButtonLink>
      </div>
    </PageShell>
  );
}
