import { LoadingCards, PageHeading, PageShell } from "@/components/ui";

export default function Loading() {
  return (
    <PageShell width="wide">
      <PageHeading title="งานที่รอครูดู" lead="กำลังอ่านผลตรวจของ AI..." />
      <LoadingCards count={4} />
    </PageShell>
  );
}
