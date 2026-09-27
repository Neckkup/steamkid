import { ButtonLink, Card, PageShell } from "@/components/ui";

/**
 * Rendered when the proxy rewrites a non-teacher request for /teacher routes
 * to this path with status 403.
 */
export default function ForbiddenPage() {
  return (
    <PageShell>
      <div className="flex flex-col items-center text-center">
        <p className="text-6xl" aria-hidden="true">
          🔒
        </p>
        <h1 className="mt-4 text-3xl font-bold leading-snug sm:text-4xl">ไม่มีสิทธิ์เข้าหน้านี้</h1>
        <p className="mt-3 text-lg text-muted">หน้านี้สำหรับคุณครูเท่านั้น</p>

        <div className="mt-8">
          <ButtonLink href="/">กลับหน้าแรก</ButtonLink>
        </div>
      </div>

      <Card className="mt-8 border-notyet bg-notyet-soft">
        <h2 className="text-xl font-bold">ท่านเป็นคุณครู?</h2>
        <p className="mt-2">
          หากท่านควรมีสิทธิ์เข้าหน้านี้ กรุณาติดต่อผู้ดูแลระบบเพื่อเพิ่มอีเมลของท่านในรายชื่อครู
        </p>
      </Card>
    </PageShell>
  );
}
