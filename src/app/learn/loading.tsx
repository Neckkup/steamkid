import { LoadingCards, PageHeading, PageShell } from "@/components/ui";

/** Shown while the lesson list resolves. Never a blank page. */
export default function LearnLoading() {
  return (
    <PageShell>
      <PageHeading title="บทเรียนของหนู" lead="กำลังเปิดบทเรียน รอสักครู่นะ" />
      <LoadingCards count={3} />
    </PageShell>
  );
}
