import { LoadingCards, PageHeading, PageShell } from "@/components/ui";

export default function Loading() {
  return (
    <PageShell width="wide">
      <PageHeading title="ผลตรวจของ AI" lead="กำลังอ่านคำตอบและระดับรายทักษะ..." />
      <LoadingCards count={3} />
    </PageShell>
  );
}
