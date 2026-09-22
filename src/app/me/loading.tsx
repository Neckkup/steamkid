import { LoadingCards, PageHeading, PageShell } from "@/components/ui";

/** Content-shaped blocks, so the page does not jump when the snapshots land. */
export default function Loading() {
  return (
    <PageShell>
      <PageHeading title="การเติบโตของหนู" lead="กำลังไปดูว่าหนูเก่งขึ้นเรื่องไหนบ้าง..." />
      <LoadingCards count={3} />
    </PageShell>
  );
}
