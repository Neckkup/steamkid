import { LoadingCards, PageHeading, PageShell } from "@/components/ui";

/** Shown while the consent state resolves — never a blank page. */
export default function ConsentLoading() {
  return (
    <PageShell>
      <PageHeading title="ความยินยอมของผู้ปกครอง" lead="กำลังโหลด รอสักครู่นะ" />
      <LoadingCards count={2} />
    </PageShell>
  );
}
